import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { pageIds } from '../shared/catalog';
import { PRIVACY_VERSION, TERMS_VERSION } from '../shared/contracts';
import { pageDiscussion } from './forum-catalog';
import { pruneEmptyDiscussionBranches } from './discussion-lifecycle';
import { cancelAuthFlows, clearAuthCookie, FRESH_AUTH_SECONDS, now, rateLimit, requireCommunityEnabled, requireSession } from './security';
import { consentSchema, handleSchema, readJson } from './validation';
import type { AppEnv } from './types';

export const account = new Hono<AppEnv>();

account.get('/', async (c) => {
  const session = requireSession(c);
  const keys = await c.env.DB.prepare('SELECT id, device_type AS deviceType, backed_up AS backedUp, created_at AS createdAt FROM passkeys WHERE user_id = ? ORDER BY created_at')
    .bind(session.user_id).all<{ id: string; deviceType: string; backedUp: number; createdAt: number }>();
  const providers = await c.env.DB.prepare('SELECT provider, created_at AS createdAt FROM social_identities WHERE user_id = ? ORDER BY provider')
    .bind(session.user_id).all<{ provider: string; createdAt: number }>();
  return c.json({ passkeys: keys.results, providers: providers.results });
});

account.post('/consent', async (c) => {
  requireCommunityEnabled(c);
  const session = requireSession(c);
  await readJson(c, consentSchema);
  const time = now();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET terms_version = ?, privacy_version = ?, accepted_at = ? WHERE id = ?')
      .bind(TERMS_VERSION, PRIVACY_VERSION, time, session.user_id),
    c.env.DB.prepare('INSERT INTO consents (user_id, terms_version, privacy_version, accepted_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, terms_version, privacy_version) DO NOTHING')
      .bind(session.user_id, TERMS_VERSION, PRIVACY_VERSION, time),
  ]);
  return c.json({ accepted: true });
});

account.post('/handle', async (c) => {
  const session = requireSession(c, { fresh: true, currentConsent: true });
  const input = await readJson(c, z.object({ handle: handleSchema }).strict());
  await rateLimit(c, 'account-handle', 10, 3600, session.user_id);
  const time = now();
  const result = await c.env.DB.prepare(`UPDATE users SET handle = ? WHERE id = ?
    AND NOT EXISTS (SELECT 1 FROM users other WHERE other.handle = ? AND other.id != ?)
    AND terms_version = ? AND privacy_version = ?
    AND EXISTS (SELECT 1 FROM sessions s WHERE s.token_hash = ? AND s.user_id = users.id
      AND s.csrf_token = ? AND s.expires_at > ? AND s.authenticated_at >= ?) RETURNING id, handle`)
    .bind(input.handle, session.user_id, input.handle, session.user_id, TERMS_VERSION, PRIVACY_VERSION,
      session.token_hash, session.csrf_token, time, time - FRESH_AUTH_SECONDS).first<{ id: string; handle: string }>();
  if (result?.id !== session.user_id) {
    throw new HTTPException(409, { message: 'The handle is unavailable or your account changed. Choose another handle or sign in again.' });
  }
  return c.json({ handle: result.handle });
});

account.post('/sessions/revoke', async (c) => {
  const session = requireSession(c, { fresh: true });
  await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(session.user_id).run();
  clearAuthCookie(c, 'session');
  clearAuthCookie(c, 'flow');
  await cancelAuthFlows(c);
  return c.json({ signedOut: true });
});

account.get('/export', async (c) => {
  const session = requireSession(c, { fresh: true });
  const data = await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare('SELECT id, handle, created_at, terms_version, privacy_version, accepted_at FROM users WHERE id = ?').bind(session.user_id),
    c.env.DB.prepare('SELECT terms_version, privacy_version, accepted_at FROM consents WHERE user_id = ?').bind(session.user_id),
    c.env.DB.prepare('SELECT lesson_id, revision, pre_answers, pre_score, post_answers, post_score, completed_at, updated_at FROM progress WHERE user_id = ?').bind(session.user_id),
    c.env.DB.prepare(`SELECT c.id, t.page_id, n.thread_id, t.forum_id, t.kind AS thread_kind, t.root_id,
      n.parent_id, n.depth, c.title, c.body, c.status, c.created_at
      FROM comments c JOIN discussion_nodes n ON n.id = c.id JOIN discussion_threads t ON t.id = n.thread_id
      WHERE c.author_id = ? AND c.status != ? ORDER BY c.created_at, c.id`).bind(session.user_id, 'removed'),
    c.env.DB.prepare('SELECT id, device_type, backed_up, created_at FROM passkeys WHERE user_id = ?').bind(session.user_id),
    c.env.DB.prepare('SELECT comment_id, reason, created_at FROM reports WHERE reporter_id = ?').bind(session.user_id),
    c.env.DB.prepare('SELECT id, reply_email, message, status, created_at FROM contact_requests WHERE user_id = ?').bind(session.user_id),
    c.env.DB.prepare('SELECT provider, identity_hash, created_at FROM social_identities WHERE user_id = ?').bind(session.user_id),
  ]);
  const exportedAccount = data[0]?.results[0];
  if (!exportedAccount) throw new HTTPException(409, { message: 'The account changed during export. Sign in again before retrying.' });
  c.header('Content-Disposition', `attachment; filename="srk-${session.handle}.json"`);
  return c.json({
    exportedAt: new Date().toISOString(),
    account: exportedAccount,
    consents: data[1]?.results,
    progress: data[2]?.results,
    contributions: data[3]?.results.map((row) => ({
      ...row,
      forum_id: typeof row.page_id === 'string' && pageIds.has(row.page_id) ? pageDiscussion(row.page_id).forumId : row.forum_id,
    })),
    passkeys: data[4]?.results,
    reports: data[5]?.results,
    contactRequests: data[6]?.results,
    linkedIdentities: data[7]?.results,
  });
});

account.delete('/', async (c) => {
  const session = requireSession(c, { fresh: true });
  const input = await readJson(c, z.object({ confirmHandle: z.string() }).strict());
  if (input.confirmHandle !== session.handle) throw new HTTPException(400, { message: 'Type your exact public handle to confirm deletion.' });
  const time = now();
  const liveSession = `EXISTS (SELECT 1 FROM sessions s WHERE s.token_hash = ? AND s.user_id = ?
    AND s.csrf_token = ? AND s.expires_at > ? AND s.authenticated_at >= ?)`;
  const credentials = [session.token_hash, session.user_id, session.csrf_token, time, time - FRESH_AUTH_SECONDS];
  const result = await c.env.DB.batch<{ id: string }>([
    c.env.DB.prepare(`DELETE FROM auth_challenges WHERE json_extract(payload, '$.userId') = ? AND ${liveSession}`)
      .bind(session.user_id, ...credentials),
    pruneEmptyDiscussionBranches(c.env.DB,
      `SELECT DISTINCT n.thread_id FROM discussion_nodes n JOIN comments c ON c.id = n.id
       WHERE c.author_id = ? AND ${liveSession}`, [session.user_id, ...credentials], session.user_id),
    c.env.DB.prepare(`DELETE FROM users WHERE id = ? AND ${liveSession} RETURNING id`)
      .bind(session.user_id, ...credentials),
  ]);
  if (result[2]?.results[0]?.id !== session.user_id) throw new HTTPException(409, { message: 'The account could not be deleted. Refresh and retry.' });
  clearAuthCookie(c, 'session');
  clearAuthCookie(c, 'flow');
  await cancelAuthFlows(c);
  return c.json({ deleted: true });
});
