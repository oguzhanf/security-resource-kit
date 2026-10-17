import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { lessons, sources } from '../shared/catalog';
import { contentEditSchema, lessonSchema } from '../shared/content-schemas';
import { PRIVACY_VERSION, TERMS_VERSION } from '../shared/contracts';
import type { Lesson } from '../shared/content-types';
import media from '../shared/training-media.json' with { type: 'json' };
import { MANAGEMENT_GITHUB_USER_ID, requireSiteManagement } from './management-access';
import { FRESH_AUTH_SECONDS, now, rateLimit, sha256 } from './security';
import { containsLikelySecret, hasDisallowedControl, readJson } from './validation';
import type { AppEnv } from './types';

interface ContentRow { lesson_id: string; revision: number; content_json: string }

function textLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(textLeaves);
  return value && typeof value === 'object' ? Object.values(value).flatMap(textLeaves) : [];
}

function effectiveLesson(base: Lesson, row: ContentRow | undefined): Lesson {
  if (!row || row.revision < base.revision) return base;
  const edited = lessonSchema.parse(JSON.parse(row.content_json));
  if (edited.id !== base.id || edited.trackId !== base.trackId || edited.revision !== row.revision) {
    throw new Error('Stored lesson content does not match its catalog identity.');
  }
  return edited;
}

export async function readLessons(db: D1Database): Promise<Lesson[]> {
  const rows = await db.prepare('SELECT lesson_id, revision, content_json FROM lesson_content').all<ContentRow>();
  return lessons.map((lesson) => effectiveLesson(lesson, rows.results.find((row) => row.lesson_id === lesson.id)));
}

export async function readLesson(db: D1Database, id: string): Promise<Lesson | undefined> {
  const base = lessons.find((lesson) => lesson.id === id);
  if (!base) return undefined;
  const row = await db.prepare('SELECT lesson_id, revision, content_json FROM lesson_content WHERE lesson_id = ?')
    .bind(id).first<ContentRow>();
  return effectiveLesson(base, row || undefined);
}

export const lessonContent = new Hono<AppEnv>();

lessonContent.post('/:id', async (c) => {
  const session = await requireSiteManagement(c);
  await rateLimit(c, 'lesson-edit', 30, 3600, session.user_id);
  const current = await readLesson(c.env.DB, c.req.param('id'));
  if (!current) throw new HTTPException(404, { message: 'Lesson not found.' });
  const input = await readJson(c, contentEditSchema);
  if (input.expectedRevision !== current.revision || input.lesson.revision !== current.revision) {
    throw new HTTPException(409, { message: 'This lesson changed. Reload it before editing; your draft has not been published.' });
  }
  if (input.lesson.id !== current.id || input.lesson.trackId !== current.trackId ||
    JSON.stringify(input.lesson.prerequisites) !== JSON.stringify(current.prerequisites)) {
    throw new HTTPException(400, { message: 'Keep stable lesson, track, and prerequisite identities. Add or reorganize courses in the source catalog.' });
  }
  if (input.lesson.sourceIds.some((id) => !sources.some((source) => source.id === id))) {
    throw new HTTPException(400, { message: 'Register and review new primary sources before citing them.' });
  }
  if (input.lesson.visuals?.some((visual) => visual.kind === 'screenshot' &&
    !media.some((asset) => visual.src === `/training-media/${asset.file}` && visual.sourceId === asset.sourceId &&
      visual.capturedAt === asset.reviewedAt && visual.provenance === 'public-documentation-redacted'))) {
    throw new HTTPException(400, { message: 'Screenshots must match the privacy-reviewed media registry. Arbitrary files or tenant captures cannot be published through this editor.' });
  }
  const text = [...textLeaves(input.lesson), input.reason].join('\n');
  if (containsLikelySecret(text) || hasDisallowedControl(text)) {
    throw new HTTPException(400, { message: 'Potential secret or control character detected. Publish only reviewed, synthetic material.' });
  }
  const updated = { ...input.lesson, revision: current.revision + 1, reviewedAt: new Date().toISOString().slice(0, 10) };
  const content = JSON.stringify(updated);
  const operation = crypto.randomUUID();
  const time = now();
  const ownerHash = await sha256(JSON.stringify(['github', 'https://github.com', MANAGEMENT_GITHUB_USER_ID]));
  // Recheck the live owner/session and consent in the same transaction as the versioned write.
  const authorized = `EXISTS (
    SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
    JOIN social_identities i ON i.user_id = u.id AND i.provider = 'github'
    WHERE s.token_hash = ? AND s.user_id = ? AND s.csrf_token = ? AND s.expires_at > ? AND s.authenticated_at >= ?
      AND u.terms_version = ? AND u.privacy_version = ? AND i.identity_hash = ?
  )`;
  const authorization = [session.token_hash, session.user_id, session.csrf_token, time, time - FRESH_AUTH_SECONDS, TERMS_VERSION, PRIVACY_VERSION, ownerHash];
  const result = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO lesson_content_history (id, lesson_id, revision, content_json, reason, editor_id, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${authorized}
      AND COALESCE((SELECT revision FROM lesson_content WHERE lesson_id = ?), ?) <= ?
      AND MAX(COALESCE((SELECT revision FROM lesson_content WHERE lesson_id = ?), ?), ?) = ?
      ON CONFLICT(lesson_id, revision) DO NOTHING`)
      .bind(operation, current.id, updated.revision, content, input.reason, session.user_id, time, ...authorization,
        current.id, current.revision, current.revision, current.id, current.revision, current.revision, input.expectedRevision),
    c.env.DB.prepare(`INSERT INTO lesson_content (lesson_id, revision, content_json, updated_at)
      SELECT lesson_id, revision, content_json, created_at FROM lesson_content_history WHERE id = ?
      ON CONFLICT(lesson_id) DO UPDATE SET revision = excluded.revision, content_json = excluded.content_json, updated_at = excluded.updated_at`)
      .bind(operation),
  ]);
  if (result[0]?.meta.changes !== 1) {
    throw new HTTPException(409, { message: 'The lesson or your authorization changed. Reload and sign in again before retrying.' });
  }
  return c.json(updated);
});
