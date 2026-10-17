import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { app } from '../server/index';
import { MANAGEMENT_GITHUB_USER_ID } from '../server/management-access';
import { now, randomToken, sha256 } from '../server/security';
import type { Env } from '../server/types';
import { lessons, sources, tracks } from '../shared/catalog';
import { lessonSchema } from '../shared/content-schemas';
import { memberCatalogSchema, progressSchema, sessionSchema } from '../shared/api-schemas';
import { PRIVACY_VERSION, TERMS_VERSION } from '../shared/contracts';
import { lessonSteps } from '../shared/lesson-flow';
import { applyNuggetDraft, nuggetDraft } from '../shared/nugget-editor';
import { trainingIssueUrl } from '../shared/feedback';
import media from '../shared/training-media.json' with { type: 'json' };
import { SqliteD1 } from './fixtures/sqlite-d1';

const origin = 'https://content.example.test';
const lesson = lessons[0];
if (!lesson) throw new Error('A published lesson is required.');
let db: SqliteD1;
let env: Env;
interface Member { id: string; csrf: string; cookie: string; tokenHash: string }

beforeEach(() => {
  db = new SqliteD1();
  env = {
    DB: db, ENVIRONMENT: 'production', APP_ORIGIN: origin, RP_ID: 'content.example.test',
    LEGAL_APPROVED: 'true', OPERATOR_NAME: 'Test operator', CONTACT_URL: `${origin}/contact`,
    TURNSTILE_SITE_KEY: 'test-widget', TURNSTILE_SECRET_KEY: 'test-widget-secret',
    RATE_LIMIT_SALT: 'test-only-private-rate-salt-not-for-production',
    ASSETS: { async fetch() { return new Response('Test member assets'); }, connect() { throw new Error('Unused socket binding.'); } },
  };
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

async function member(handle: string, owner = false, role = 'learner'): Promise<Member> {
  const id = crypto.randomUUID();
  const token = randomToken();
  const tokenHash = await sha256(token);
  const csrf = randomToken();
  await db.batch([
    db.prepare('INSERT INTO users (id,handle,role,terms_version,privacy_version,accepted_at,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(id, handle, role, TERMS_VERSION, PRIVACY_VERSION, now(), now()),
    db.prepare('INSERT INTO sessions (token_hash,user_id,csrf_token,authenticated_at,expires_at) VALUES (?,?,?,?,?)')
      .bind(tokenHash, id, csrf, now(), now() + 3600),
  ]);
  if (owner) await db.prepare("INSERT INTO social_identities (provider,identity_hash,user_id,created_at) VALUES ('github',?,?,?)")
    .bind(await sha256(JSON.stringify(['github', 'https://github.com', MANAGEMENT_GITHUB_USER_ID])), id, now()).run();
  return { id, tokenHash, csrf, cookie: `__Host-srk-session=${token}` };
}

async function api(path: string, identity?: Member, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(`${origin}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'CF-Connecting-IP': '192.0.2.1',
      ...(identity ? { Cookie: identity.cookie, 'X-CSRF-Token': identity.csrf } : {}),
      ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json', 'X-SRK-Request': '1' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
}

const edit = () => ({
  expectedRevision: lesson.revision,
  lesson: { ...lesson, gist: `${lesson.gist} Preserve the reviewed object boundaries.` },
  reason: 'Clarify the reviewed operational boundaries.',
  technicalReviewConfirmed: true,
});

describe('reusable visual content and editor boundaries', () => {
  it('validates all courses and attaches real, source-backed teaching visuals', () => {
    const xdr = tracks.find((track) => track.id === 'defender-xdr-secops');
    expect(xdr?.status).toBe('available');
    expect(xdr?.lessonIds).toHaveLength(7);
    for (const item of lessons) {
      expect(lessonSchema.safeParse(item).success, item.id).toBe(true);
      expect(item.visuals?.filter((visual) => visual.kind === 'diagram').length).toBeGreaterThanOrEqual(2);
      for (const visual of item.visuals || []) {
        expect(sources.some((source) => source.id === visual.sourceId)).toBe(true);
        expect(lessonSteps(item).some((step) => step.id === visual.stepId)).toBe(true);
      }
    }
  });

  it('edits every authored nugget through the same schema without making completion editable', () => {
    for (const item of lessons) for (const step of lessonSteps(item)) {
      if (step.kind === 'complete') continue;
      expect(applyNuggetDraft(item, step, nuggetDraft(item, step))).toEqual({
        ...item, visuals: [...(item.visuals || []).filter((visual) => visual.stepId !== step.id), ...(item.visuals || []).filter((visual) => visual.stepId === step.id)],
      });
    }
    expect(() => applyNuggetDraft(lesson, { id: 'complete', kind: 'complete' }, { content: {}, visuals: [] })).toThrow('not editable');
    expect(() => applyNuggetDraft(lesson, { id: 'summary', kind: 'summary' }, {
      content: { gist: 'word '.repeat(101), objective: 'An objective.' }, visuals: [],
    })).toThrow('100 words');
  });

  it('publishes a persistent new revision, uses it for grading, and rejects stale writes', async () => {
    const owner = await member('owner', true);
    const saved = await api(`/management/content/${lesson.id}`, owner, edit());
    expect(saved.status).toBe(200);
    const updated = lessonSchema.parse(await saved.json());
    expect(updated.revision).toBe(lesson.revision + 1);
    expect(updated.reviewedAt).toBe(new Date().toISOString().slice(0, 10));
    const catalog = memberCatalogSchema.parse(await (await api('/catalog', owner)).json());
    expect(catalog.lessons.find((item) => item.id === lesson.id)).toEqual(updated);
    expect((await api(`/management/content/${lesson.id}`, owner, edit())).status).toBe(409);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM lesson_content_history').get()?.count).toBe(1);
    expect((await api(`/lessons/${lesson.id}/attempts`, owner, {
      stage: 'pre', revision: lesson.revision, answers: lesson.preflight.map((question) => question.correct),
    })).status).toBe(409);
    const result = await api(`/lessons/${lesson.id}/attempts`, owner, {
      stage: 'pre', revision: updated.revision, answers: updated.preflight.map((question) => question.correct),
    });
    expect(result.status).toBe(200);
    expect(progressSchema.parse(await result.json()).revision).toBe(updated.revision);
  });

  it('requires the pinned owner, fresh session, CSRF, current consent, and same-origin boundary', async () => {
    const learner = await member('learner');
    const moderator = await member('reviewer', false, 'moderator');
    const owner = await member('owner', true);
    const path = `/management/content/${lesson.id}`;
    expect((await api(path, undefined, edit())).status).toBe(401);
    expect((await api(path, learner, edit())).status).toBe(403);
    expect((await api(path, moderator, edit())).status).toBe(403);
    expect((await api(path, owner, edit(), { 'X-CSRF-Token': '' })).status).toBe(403);
    expect((await api(path, owner, edit(), { Origin: 'https://other.example' })).status).toBe(403);
    await db.prepare('UPDATE sessions SET authenticated_at = ? WHERE token_hash = ?').bind(now() - 301, owner.tokenHash).run();
    expect((await api(path, owner, edit())).status).toBe(403);
    await db.prepare('UPDATE sessions SET authenticated_at = ? WHERE token_hash = ?').bind(now(), owner.tokenHash).run();
    await db.prepare("UPDATE users SET terms_version = 'old' WHERE id = ?").bind(owner.id).run();
    expect((await api(path, owner, edit())).status).toBe(428);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM lesson_content').get()?.count).toBe(0);
  });

  it('rechecks owner revocation at commit and serializes concurrent revisions without orphan history', async () => {
    const owner = await member('owner', true);
    const path = `/management/content/${lesson.id}`;
    const batch = db.batch.bind(db);
    vi.spyOn(db, 'batch').mockImplementationOnce(async (statements) => {
      db.sqlite.prepare('DELETE FROM social_identities WHERE user_id = ?').run(owner.id);
      return batch(statements);
    });
    expect((await api(path, owner, edit())).status).toBe(409);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM lesson_content_history').get()?.count).toBe(0);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM lesson_content').get()?.count).toBe(0);
    await db.prepare("INSERT INTO social_identities (provider,identity_hash,user_id,created_at) VALUES ('github',?,?,?)")
      .bind(await sha256(JSON.stringify(['github', 'https://github.com', MANAGEMENT_GITHUB_USER_ID])), owner.id, now()).run();
    const responses = await Promise.all([api(path, owner, edit()), api(path, owner, edit())]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM lesson_content_history').get()?.count).toBe(1);
    expect(db.sqlite.prepare('SELECT revision FROM lesson_content').get()?.revision).toBe(lesson.revision + 1);
  });

  it('rejects identity changes, unregistered sources, secret material, and unreviewed screenshots', async () => {
    const owner = await member('owner', true);
    const path = `/management/content/${lesson.id}`;
    const payload = edit();
    expect((await api(path, owner, { ...payload, lesson: { ...payload.lesson, id: 'different-id' } })).status).toBe(400);
    expect((await api(path, owner, { ...payload, lesson: { ...payload.lesson, sourceIds: [...lesson.sourceIds, 'unregistered'] } })).status).toBe(400);
    expect((await api(path, owner, { ...payload, lesson: { ...payload.lesson, objective: `ghp_${'x'.repeat(40)}` } })).status).toBe(400);
    expect((await api(path, owner, { ...payload, lesson: { ...payload.lesson, objective: `Unsafe${String.fromCharCode(1)}content` } })).status).toBe(400);
    expect((await api(path, owner, { ...payload, lesson: { ...payload.lesson, visuals: [{
      id: 'unsafe-image', kind: 'screenshot', stepId: 'summary', title: 'Screenshot', caption: 'Not reviewed.',
      sourceId: lesson.sourceIds[0], src: '/training-media/unreviewed.png', alt: 'Unreviewed capture.',
      capturedAt: '2026-10-17', provenance: 'tenant-redacted',
    }] } })).status).toBe(400);
  });

  it('publishes only cropped, metadata-free image outputs with approved source and privacy records', async () => {
    expect(media.length).toBeGreaterThanOrEqual(4);
    for (const asset of media) {
      expect(sources.some((source) => source.id === asset.sourceId)).toBe(true);
      expect(asset.privacyReview.length).toBeGreaterThan(60);
      const bytes = readFileSync(join(process.cwd(), 'public', 'training-media', asset.file));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.outputSha256);
      const metadata = await sharp(bytes).metadata();
      expect([metadata.width, metadata.height]).toEqual([asset.crop.width, asset.crop.height]);
      expect(metadata.exif).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
      expect(metadata.iptc).toBeUndefined();
      for (const mask of asset.masks) {
        const pixels = await sharp(bytes).extract(mask).removeAlpha().raw().toBuffer();
        expect(pixels.every((value) => value === 34)).toBe(true);
      }
    }
  });

  it('prefills public GitHub issues only with stable content coordinates', () => {
    const url = new URL(trainingIssueUrl('identity-model', 2, 'summary'));
    expect(url.pathname).toBe('/oguzhanf/security-resource-kit/issues/new');
    expect(url.searchParams.get('body')).toContain('Revision: 2');
    expect(url.searchParams.get('body')).toContain('issue is PUBLIC');
    expect(url.searchParams.get('body')).not.toContain(lesson.gist);
  });
});

describe('independent public site handles', () => {
  it('renames the site handle without replacing provider identity, account ID, or management authorization', async () => {
    const owner = await member('oguzhanf-personal', true);
    const response = await api('/account/handle', owner, { handle: 'oguzhanf' });
    expect(response.status).toBe(200);
    const session = sessionSchema.parse(await (await api('/auth/me', owner)).json());
    expect(session.user?.id).toBe(owner.id);
    expect(session.user?.handle).toBe('oguzhanf');
    expect(session.managementLink?.href).toBe('/management');
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM social_identities WHERE user_id = ?').get(owner.id)?.count).toBe(1);
  });

  it('rejects collisions, reserved handles, stale authentication, and missing CSRF', async () => {
    const first = await member('first-user');
    await member('occupied');
    expect((await api('/account/handle', first, { handle: 'occupied' })).status).toBe(409);
    expect((await api('/account/handle', first, { handle: 'admin' })).status).toBe(400);
    expect((await api('/account/handle', first, { handle: 'new-handle' }, { 'X-CSRF-Token': '' })).status).toBe(403);
    await db.prepare('UPDATE sessions SET authenticated_at = ? WHERE token_hash = ?').bind(now() - 301, first.tokenHash).run();
    expect((await api('/account/handle', first, { handle: 'new-handle' })).status).toBe(403);
    expect(db.sqlite.prepare('SELECT handle FROM users WHERE id = ?').get(first.id)?.handle).toBe('first-user');
  });
});
