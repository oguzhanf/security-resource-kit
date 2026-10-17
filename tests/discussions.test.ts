import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { app } from '../server/index';
import { MANAGEMENT_GITHUB_USER_ID } from '../server/management-access';
import { now, randomToken, sha256 } from '../server/security';
import type { Env } from '../server/types';
import {
  commentResponseSchema, discussionSchema, forumIndexSchema, forumPageSchema,
} from '../shared/api-schemas';
import { lessons, pageIds, tracks } from '../shared/catalog';
import { DISCUSSION_MAX_DEPTH, PRIVACY_VERSION, TERMS_VERSION } from '../shared/contracts';
import type { Comment, DiscussionPage } from '../shared/contracts';
import { SqliteD1 } from './fixtures/sqlite-d1';

const origin = 'https://forum.example.test';
let db: SqliteD1;
let env: Env;
const outbound = vi.fn<typeof fetch>();

interface Member {
  id: string;
  handle: string;
  cookie: string;
  csrf: string;
  tokenHash: string;
}

beforeEach(() => {
  db = new SqliteD1();
  env = {
    DB: db, ENVIRONMENT: 'production', APP_ORIGIN: origin, RP_ID: 'forum.example.test',
    LEGAL_APPROVED: 'true', OPERATOR_NAME: 'Test operator', CONTACT_URL: `${origin}/contact`,
    TURNSTILE_SITE_KEY: 'test-widget', TURNSTILE_SECRET_KEY: 'test-widget-secret',
    RATE_LIMIT_SALT: 'test-only-private-rate-salt-not-for-production', GITHUB_CLIENT_ID: 'test-only-client', GITHUB_CLIENT_SECRET: 'test-only-secret',
    ASSETS: { async fetch() { return new Response('Member HTML'); }, connect() { throw new Error('Unused socket binding.'); } },
  };
  outbound.mockReset();
  outbound.mockImplementation(async (input, options) => {
    if (String(input) !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify' || !(options?.body instanceof URLSearchParams)) {
      throw new Error('Unexpected outbound request.');
    }
    return Response.json({
      success: true, hostname: 'forum.example.test',
      action: options.body.get('response') === 'registration-proof' ? 'register' : 'contact',
    });
  });
  vi.stubGlobal('fetch', outbound);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.close();
});

async function member(handle: string, role: 'learner' | 'moderator' = 'learner', githubId?: string): Promise<Member> {
  const id = crypto.randomUUID();
  const csrf = randomToken();
  const token = randomToken();
  const tokenHash = await sha256(token);
  const time = now();
  await db.batch([
    db.prepare('INSERT INTO users (id,handle,role,terms_version,privacy_version,accepted_at,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(id, handle, role, TERMS_VERSION, PRIVACY_VERSION, time, time),
    db.prepare('INSERT INTO sessions (token_hash,user_id,csrf_token,authenticated_at,expires_at) VALUES (?,?,?,?,?)')
      .bind(tokenHash, id, csrf, time, time + 3600),
    db.prepare('INSERT INTO consents (user_id,terms_version,privacy_version,accepted_at) VALUES (?,?,?,?)')
      .bind(id, TERMS_VERSION, PRIVACY_VERSION, time),
  ]);
  if (githubId) {
    await db.prepare("INSERT INTO social_identities (provider,identity_hash,user_id,created_at) VALUES ('github',?,?,?)")
      .bind(await sha256(JSON.stringify(['github', 'https://github.com', githubId])), id, time).run();
  }
  return { id, handle, cookie: `__Host-srk-session=${token}`, csrf, tokenHash };
}

async function api(path: string, identity?: Member, options: {
  method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; headers?: Record<string, string>;
} = {}): Promise<Response> {
  const method = options.method || 'GET';
  return app.request(`${origin}${path}`, {
    method, headers: {
      'CF-Connecting-IP': '198.51.100.12',
      ...(identity ? { Cookie: identity.cookie, 'X-CSRF-Token': identity.csrf } : {}),
      ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json', 'X-SRK-Request': '1' }),
      ...options.headers,
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(options.body || {}) }),
  }, env);
}

async function discussion(path: string, identity: Member): Promise<DiscussionPage> {
  const response = await api(path, identity);
  expect(response.status, path).toBe(200);
  return discussionSchema.parse(await response.json());
}

async function root(identity: Member, pageId = 'home', status: Comment['status'] = 'published', body = 'A synthetic page discussion root.', createdAt = now()): Promise<string> {
  const id = crypto.randomUUID();
  await db.prepare('INSERT INTO comments (id,page_id,author_id,body,status,created_at) VALUES (?,?,?,?,?,?)')
    .bind(id, pageId, identity.id, body, status, createdAt).run();
  return id;
}

async function child(parentId: string, identity: Member, status: Comment['status'] = 'published', body = 'A synthetic direct reply.', createdAt = now()): Promise<string> {
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare(`INSERT INTO discussion_nodes (id,thread_id,parent_id,depth,created_at)
      SELECT ?, thread_id, id, depth + 1, ? FROM discussion_nodes WHERE id = ?`).bind(id, createdAt, parentId),
    db.prepare(`INSERT INTO comments (id,page_id,author_id,body,status,created_at)
      SELECT n.id, COALESCE(t.page_id, ''), ?, ?, ?, n.created_at
      FROM discussion_nodes n JOIN discussion_threads t ON t.id = n.thread_id WHERE n.id = ?`)
      .bind(identity.id, body, status, id),
  ]);
  return id;
}

async function seededQuestion(identity: Member, forumId = 'site', status: Comment['status'] = 'published', title = 'A synthetic independent question', createdAt = now()) {
  const threadId = crypto.randomUUID();
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO discussion_threads (id,kind,forum_id,root_id,created_at) VALUES (?, 'question', ?, ?, ?)")
      .bind(threadId, forumId, id, createdAt),
    db.prepare('INSERT INTO discussion_nodes (id,thread_id,parent_id,depth,created_at) VALUES (?,?,NULL,0,?)')
      .bind(id, threadId, createdAt),
    db.prepare("INSERT INTO comments (id,page_id,author_id,body,title,status,created_at) VALUES (?, '', ?, ?, ?, ?, ?)")
      .bind(id, identity.id, 'Initial synthetic independent question content.', title, status, createdAt),
  ]);
  return { threadId, id };
}

async function question(identity: Member, forumId = 'site', title = 'A synthetic independent question') {
  const response = await api(`/api/forums/${forumId}/threads`, identity, {
    method: 'POST', body: { title, body: 'Which boundary applies to this synthetic independent question?' },
  });
  expect(response.status).toBe(201);
  return discussionSchema.parse(await response.json());
}

async function review(id: string, reviewer: Member, action: 'publish' | 'hide' = 'publish', management = false) {
  const response = await api(`/api/${management ? 'management/contributions' : 'moderation'}/${id}`, reviewer, { method: 'POST', body: { action } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ reviewed: true });
}

describe('additive discussion migration', () => {
  it('preserves every UUID, body, status, report reference and review/audit field', async () => {
    const legacy = new SqliteD1(['0001_initial.sql', '0002_private_contact.sql', '0003_social_login.sql']);
    try {
      const author = crypto.randomUUID();
      const reviewer = crypto.randomUUID();
      for (const [id, handle] of [[author, 'legacy-author'], [reviewer, 'legacy-reviewer']]) {
        await legacy.prepare('INSERT INTO users (id,handle,terms_version,privacy_version,accepted_at,created_at) VALUES (?,?,?,?,1,1)')
          .bind(id, handle, TERMS_VERSION, PRIVACY_VERSION).run();
      }
      const statuses = ['pending', 'published', 'hidden', 'removed'];
      const ids = statuses.map(() => crypto.randomUUID());
      for (const [index, id] of ids.entries()) {
        await legacy.prepare('INSERT INTO comments (id,page_id,author_id,body,status,created_at,reviewed_at,reviewed_by) VALUES (?,?,?,?,?,?,?,?)')
          .bind(id, index % 2 ? 'identity-model' : 'home', author, `Preserve original body ${index}`, statuses[index], 100 + index, 200 + index, reviewer).run();
        await legacy.prepare('INSERT INTO reports (comment_id,reporter_id,reason,created_at) VALUES (?,?,?,?)')
          .bind(id, reviewer, `Original report reason ${index}`, 300 + index).run();
        await legacy.prepare('INSERT INTO moderation_audit (id,moderator_id,comment_id,action,created_at) VALUES (?,?,?,?,?)')
          .bind(crypto.randomUUID(), reviewer, id, index % 2 ? 'publish' : 'hide', 400 + index).run();
      }
      const originalComments = (await legacy.prepare('SELECT * FROM comments ORDER BY id').all<Record<string, unknown>>()).results;
      const originalReports = (await legacy.prepare('SELECT * FROM reports ORDER BY comment_id').all()).results;
      const originalHistory = (await legacy.prepare('SELECT * FROM moderation_audit ORDER BY id').all()).results;
      await legacy.exec(readFileSync(join(process.cwd(), 'migrations', '0004_threaded_discussions.sql'), 'utf8'));
      expect((await legacy.prepare('SELECT * FROM comments ORDER BY id').all()).results).toEqual(originalComments.map((row) => ({ ...row, title: null })));
      expect((await legacy.prepare('SELECT * FROM reports ORDER BY comment_id').all()).results).toEqual(originalReports);
      expect((await legacy.prepare('SELECT * FROM moderation_audit ORDER BY id').all()).results).toEqual(originalHistory);
      expect((await legacy.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
      expect((await legacy.prepare('SELECT id FROM discussion_nodes ORDER BY id').all<{ id: string }>()).results.map((row) => row.id)).toEqual([...ids].sort());
      expect(await legacy.prepare('SELECT COUNT(*) AS count FROM discussion_threads').first('count')).toBe(2);
      const freshId = crypto.randomUUID();
      await legacy.prepare("INSERT INTO comments (id,page_id,author_id,body,created_at) VALUES (?, 'home', ?, 'Direct legacy insert remains coherent.', 500)")
        .bind(freshId, author).run();
      expect(await legacy.prepare('SELECT thread_id,parent_id,depth FROM discussion_nodes WHERE id=?').bind(freshId).first())
        .toEqual({ thread_id: 'page-home', parent_id: null, depth: 0 });
    } finally { legacy.close(); }
  });
});

describe('member-only categories and shared page conversations', () => {
  it('derives exactly the published categories and protects every central route', async () => {
    const learner = await member('catalog-member');
    const index = forumIndexSchema.parse(await (await api('/api/forums', learner)).json());
    expect(index).toEqual({
      categories: [
        ...tracks.filter((track) => track.status === 'available').map((track) => ({
          id: track.id, title: track.title, kind: 'course', lessonCount: lessons.filter((lesson) => lesson.trackId === track.id).length,
        })),
        { id: 'site', title: 'Site discussions', kind: 'site', lessonCount: 0 },
        { id: 'announcements', title: 'Announcements', kind: 'announcements', lessonCount: 0 },
      ], canAnnounce: false,
    });
    expect(index.categories.map((category) => category.lessonCount)).toEqual([6, 8, 7, 0, 0]);
    for (const path of ['/api/forums', '/api/forums/site', '/api/threads/page-home', `/api/comments/${crypto.randomUUID()}/replies`]) {
      expect((await api(path)).status, path).toBe(401);
    }
    for (const path of ['/discussions', '/discussions/site', '/discussions/site/page-home']) {
      const denied = await api(path);
      expect(denied.status).toBe(303);
      expect(denied.headers.get('location')).toBe('/');
      expect(denied.headers.get('cache-control')).toBe('no-store');
      expect((await api(path, learner)).status).toBe(200);
    }
    expect((await api('/api/forums/workload-identity', learner)).status).toBe(404);
    await db.prepare('UPDATE users SET privacy_version = ? WHERE id = ?').bind('old', learner.id).run();
    expect((await api('/api/forums', learner)).status).toBe(428);
    expect((await api('/discussions/site', learner)).headers.get('location')).toBe('/account');
  });

  it('shows personal activity and direct replies only through fully visible ancestor paths', async () => {
    const author = await member('activity-author');
    const other = await member('activity-other');
    const initial = await root(author);
    const pending = await child(initial, author, 'pending', 'My synthetic pending contribution.');
    const reply = await child(initial, other, 'published', 'A published reply to the author.');
    const hiddenParent = await child(initial, other, 'hidden', 'A private intermediate contribution.');
    const descendant = await child(hiddenParent, author, 'published', 'An inaccessible nested contribution.');
    const mine = z.array(commentResponseSchema).parse(await (await api('/api/community/activity?view=mine', author)).json());
    expect(mine.map((entry) => entry.id)).toEqual(expect.arrayContaining([initial, pending]));
    expect(mine.map((entry) => entry.id)).not.toContain(descendant);
    const replies = z.array(commentResponseSchema).parse(await (await api('/api/community/activity?view=replies', author)).json());
    expect(replies.map((entry) => entry.id)).toEqual([reply]);
    expect((await api('/api/community/activity')).status).toBe(401);
    expect((await api('/api/community/activity?view=all', author)).status).toBe(400);
  });

  it('lets fresh reviewers explicitly find published and hidden contributions without changing member visibility', async () => {
    const author = await member('filter-author');
    const owner = await member('filter-owner', 'learner', MANAGEMENT_GITHUB_USER_ID);
    const pending = await root(author, 'home', 'pending');
    const published = await root(author, 'home', 'published');
    const hidden = await root(author, 'home', 'hidden');
    const queue = async (status: string) => z.array(commentResponseSchema).parse(await (await api(`/api/management/contributions?status=${status}`, owner)).json());
    expect((await queue('pending')).map((entry) => entry.id)).toEqual([pending]);
    expect((await queue('published')).map((entry) => entry.id)).toEqual([published]);
    expect((await queue('hidden')).map((entry) => entry.id)).toEqual([hidden]);
    expect((await api('/api/management/contributions?status=invalid', owner)).status).toBe(400);
    expect((await discussion('/api/discussions/home', owner)).comments.map((entry) => entry.id)).toEqual([published]);
  });

  it('aggregates catalog page roots once, with identical IDs and conversation data', async () => {
    const learner = await member('page-author');
    const observer = await member('page-observer');
    const id = await root(learner, 'mdti-hunting', 'pending', 'A synthetic intelligence-led hunting question.');
    await root(learner, 'identity-model');
    const direct = await discussion('/api/discussions/mdti-hunting', learner);
    expect(direct.thread).toEqual({
      id: 'page-mdti-hunting', forumId: 'defender-threat-intelligence', pageId: 'mdti-hunting',
      kind: 'page', title: lessons.find((lesson) => lesson.id === 'mdti-hunting')?.title, rootCommentId: null,
    });
    expect(direct.comments[0]).toEqual({
      id, pageId: 'mdti-hunting', threadId: direct.thread.id, forumId: direct.thread.forumId,
      threadTitle: direct.thread.title, threadKind: 'page', parentId: null, depth: 0, replyCount: 0,
      handle: learner.handle, body: 'A synthetic intelligence-led hunting question.', status: 'pending',
      createdAt: await db.prepare('SELECT created_at FROM comments WHERE id=?').bind(id).first('created_at'), own: true,
    });
    expect(await discussion('/api/threads/page-mdti-hunting', learner)).toEqual(direct);
    const category = forumPageSchema.parse(await (await api('/api/forums/defender-threat-intelligence', learner)).json());
    expect(category.pageDiscussions.map((entry) => entry.pageId)).toEqual([
      'track-defender-threat-intelligence', ...lessons.filter((lesson) => lesson.trackId === 'defender-threat-intelligence').map((lesson) => lesson.id),
    ]);
    expect(category.pageDiscussions.find((entry) => entry.id === direct.thread.id)?.rootPosts).toBe(1);
    expect(category.pageDiscussions.some((entry) => entry.pageId === 'identity-model')).toBe(false);
    const privateCategory = forumPageSchema.parse(await (await api('/api/forums/defender-threat-intelligence', observer)).json());
    expect(privateCategory.pageDiscussions.find((entry) => entry.id === direct.thread.id)).toMatchObject({ rootPosts: 0, latestPostAt: null });
    const site = forumPageSchema.parse(await (await api('/api/forums/site', learner)).json());
    expect(site.pageDiscussions.map((entry) => entry.pageId)).toEqual([...pageIds].filter((page) => !lessons.some((lesson) => lesson.id === page) && !page.startsWith('track-')));
    expect(await db.prepare('SELECT COUNT(*) AS count FROM comments WHERE id=?').bind(id).first('count')).toBe(1);
  });
});

describe('authenticated posting without robot verification', () => {
  it('keeps production registration/contact Turnstile but never challenges signed-in posts or replies', async () => {
    const learner = await member('no-captcha-member');
    const body = 'A synthetic page question without a robot token.';
    const posted = await api('/api/discussions/home', learner, { method: 'POST', body: { body } });
    expect(posted.status).toBe(201);
    const comment = commentResponseSchema.parse(await posted.json());
    expect(comment.status).toBe('pending');
    const reply = await api(`/api/comments/${comment.id}/replies`, learner, {
      method: 'POST', body: { body: 'A synthetic nested reply without a robot token.', turnstileToken: 'legacy-client-field-ignored' },
    });
    expect(reply.status).toBe(201);
    expect(commentResponseSchema.parse(await reply.json())).toMatchObject({ parentId: comment.id, depth: 1, status: 'pending' });
    expect((await question(learner)).comments[0]?.status).toBe('pending');
    expect(outbound).not.toHaveBeenCalled();
    const registration = { handle: 'production-bot-test', accepted: true, termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION };
    expect((await api('/api/auth/register/options', undefined, { method: 'POST', body: registration })).status).toBe(400);
    expect((await api('/api/contact', undefined, { method: 'POST', body: { message: 'A private public contact without proof.' } })).status).toBe(400);
    expect((await api('/api/contact', learner, { method: 'POST', body: { message: 'A signed-in private contact without proof.' } })).status).toBe(400);
    expect(outbound).not.toHaveBeenCalled();
    expect((await api('/api/auth/register/options', undefined, { method: 'POST', body: { ...registration, turnstileToken: 'registration-proof' } })).status).toBe(200);
    expect((await api('/api/contact', undefined, { method: 'POST', body: { message: 'A private public contact with proof.', turnstileToken: 'contact-proof' } })).status).toBe(201);
    expect((await api('/api/contact', learner, { method: 'POST', body: { message: 'A signed-in private contact with proof.', turnstileToken: 'contact-proof' } })).status).toBe(201);
    expect(outbound).toHaveBeenCalledTimes(3);
  });

  it('retains origin, JSON/header, CSRF, consent, secret/control, and strict-field checks', async () => {
    const learner = await member('posting-boundaries');
    const body = { body: 'A safe synthetic discussion contribution.' };
    const invalidHeaders: Record<string, string>[] = [
      { Origin: 'https://attacker.example' }, { 'X-SRK-Request': '' }, { 'X-CSRF-Token': '' }, { 'X-CSRF-Token': 'invalid' }, { 'Sec-Fetch-Site': 'cross-site' },
    ];
    for (const headers of invalidHeaders) {
      expect((await api('/api/discussions/home', learner, { method: 'POST', body, headers })).status).toBe(403);
    }
    expect((await api('/api/discussions/home', learner, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' } })).status).toBe(415);
    for (const value of [
      { body: `ghp_${'x'.repeat(30)}` }, { body: `A hidden\u0000control character.` },
      { ...body, status: 'published' }, { ...body, authorId: crypto.randomUUID() }, { ...body, parentId: crypto.randomUUID() },
    ]) {
      expect((await api('/api/discussions/home', learner, { method: 'POST', body: value })).status).toBe(400);
    }
    for (const title of ['tiny', 'x'.repeat(161), 'A multiline\ntitle', `github_pat_${'x'.repeat(30)}`]) {
      expect((await api('/api/forums/site/threads', learner, { method: 'POST', body: { title, body: body.body } })).status).toBe(400);
    }
    await db.prepare("UPDATE users SET terms_version='old' WHERE id=?").bind(learner.id).run();
    for (const path of ['/api/discussions/home', '/api/forums/site/threads']) {
      expect((await api(path, learner, { method: 'POST', body: { ...body, title: 'A synthetic title' } })).status).toBe(428);
    }
    expect(await db.prepare('SELECT COUNT(*) AS count FROM comments').first('count')).toBe(0);
  });

  it('shares account and network posting limits across questions, comments, and replies', async () => {
    const learner = await member('rate-member');
    const parent = await root(learner);
    for (let index = 0; index < 12; index++) {
      const path = index % 3 === 0 ? '/api/discussions/home' : index % 3 === 1 ? '/api/forums/site/threads' : `/api/comments/${parent}/replies`;
      const response = await api(path, learner, { method: 'POST', body: index % 3 === 1
        ? { title: `Synthetic question ${index}`, body: 'A safe synthetic initial question.' }
        : { body: `A safe synthetic contribution ${index}.` } });
      expect(response.status).toBe(201);
    }
    const denied = await api('/api/forums/site/threads', learner, { method: 'POST', body: { title: 'Another synthetic question', body: 'A safe synthetic initial question.' } });
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM comments').first('count')).toBe(13);
    await db.prepare('DELETE FROM rate_limits').run();
    const network = await sha256(`${env.RATE_LIMIT_SALT}:comment-network:198.51.100.12:${Math.floor(now() / 3600)}`);
    await db.prepare('INSERT INTO rate_limits (bucket_key,hits,expires_at) VALUES (?,30,?)').bind(network, now() + 3600).run();
    const another = await member('network-member');
    expect((await api('/api/discussions/home', another, { method: 'POST', body: { body: 'A network-limited synthetic contribution.' } })).status).toBe(429);
  });
});

describe('independent questions, announcements and review context', () => {
  it('stores an independent title/root and keeps both private until root approval', async () => {
    const author = await member('question-author');
    const observer = await member('question-observer');
    const moderator = await member('question-reviewer', 'moderator');
    const created = await question(author, 'agent-identity', '<script>A synthetic title</script>');
    const initial = created.comments[0];
    if (!initial) throw new Error('Missing initial post.');
    expect(created).toMatchObject({
      thread: { id: initial.threadId, forumId: 'agent-identity', kind: 'question', pageId: null, rootCommentId: initial.id, title: '<script>A synthetic title</script>' },
      comments: [{ parentId: null, depth: 0, status: 'pending', own: true, pageId: null }], nextCursor: null,
    });
    expect(await db.prepare('SELECT thread_id,parent_id,depth FROM discussion_nodes WHERE id=?').bind(initial.id).first())
      .toEqual({ thread_id: initial.threadId, parent_id: null, depth: 0 });
    expect(await db.prepare('SELECT page_id,title,status FROM comments WHERE id=?').bind(initial.id).first())
      .toEqual({ page_id: '', title: created.thread.title, status: 'pending' });
    expect((await api(`/api/threads/${created.thread.id}`, observer)).status).toBe(404);
    expect(forumPageSchema.parse(await (await api('/api/forums/agent-identity', observer)).json()).threads).toEqual([]);
    const own = forumPageSchema.parse(await (await api('/api/forums/agent-identity', author)).json());
    expect(own.threads.map((entry) => entry.id)).toEqual([created.thread.id]);
    const queued = z.array(commentResponseSchema).parse(await (await api('/api/moderation', moderator)).json());
    expect(queued[0]).toMatchObject({ id: initial.id, pageId: null, threadTitle: created.thread.title, ancestors: [] });
    await review(initial.id, moderator);
    const publicThread = await discussion(`/api/threads/${created.thread.id}`, observer);
    expect(publicThread.thread).toEqual(created.thread);
    expect(publicThread.comments[0]).toMatchObject({ body: initial.body, status: 'published', own: false });
  });

  it('requires the exact fresh personal GitHub owner for announcement roots, never handles or roles', async () => {
    const handles = [
      await member('oguzhanf'), await member('oguzhanf_microsoft', 'moderator', '123456789'),
      await member('generic-moderator', 'moderator'),
    ];
    const input = { title: 'A synthetic owner announcement', body: 'This is a synthetic announcement for member tests.' };
    for (const impersonator of handles) {
      expect((await api('/api/forums/announcements/threads', impersonator, { method: 'POST', body: input })).status).toBe(403);
      expect(forumIndexSchema.parse(await (await api('/api/forums', impersonator)).json()).canAnnounce).toBe(false);
    }
    const owner = await member('verified-personal-owner', 'learner', MANAGEMENT_GITHUB_USER_ID);
    expect(forumIndexSchema.parse(await (await api('/api/forums', owner)).json()).canAnnounce).toBe(true);
    const announcement = await question(owner, 'announcements', input.title);
    const initial = announcement.comments[0];
    if (!initial) throw new Error('Missing announcement post.');
    expect(initial).toMatchObject({ status: 'published', threadKind: 'announcement', pageId: null });
    expect(await db.prepare('SELECT reviewed_by FROM comments WHERE id=?').bind(initial.id).first('reviewed_by')).toBe(owner.id);
    expect(await db.prepare('SELECT action,moderator_id,comment_id FROM moderation_audit').first())
      .toEqual({ action: 'publish', moderator_id: owner.id, comment_id: initial.id });
    const reply = await api(`/api/comments/${initial.id}/replies`, handles[0], { method: 'POST', body: { body: 'A member reply subject to normal moderation.' } });
    expect(reply.status).toBe(201);
    expect(commentResponseSchema.parse(await reply.json()).status).toBe('pending');
    expect((await discussion(`/api/comments/${initial.id}/replies`, owner)).comments).toHaveLength(0);
    await db.prepare('UPDATE sessions SET authenticated_at=? WHERE user_id=?').bind(now() - 301, owner.id).run();
    expect((await api('/api/forums/announcements/threads', owner, { method: 'POST', body: input })).status).toBe(403);
    await db.prepare('UPDATE sessions SET authenticated_at=? WHERE user_id=?').bind(now(), owner.id).run();
    await db.prepare('DELETE FROM social_identities WHERE user_id=?').bind(owner.id).run();
    expect((await api('/api/forums/announcements/threads', owner, { method: 'POST', body: input })).status).toBe(403);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM discussion_threads WHERE kind='announcement'").first('count')).toBe(1);
  });

  it('keeps both review mounts operational with full private thread/parent context', async () => {
    const author = await member('nested-question-author');
    const moderator = await member('nested-moderator', 'moderator');
    const owner = await member('nested-owner', 'learner', MANAGEMENT_GITHUB_USER_ID);
    const created = await question(author);
    const initial = created.comments[0];
    if (!initial) throw new Error('Missing initial question.');
    const reply = await child(initial.id, author, 'pending', 'A synthetic pending reply for review context.');
    const queue = z.array(commentResponseSchema).parse(await (await api('/api/moderation', moderator)).json());
    const queued = queue.find((entry) => entry.id === reply);
    expect(queued?.ancestors).toEqual([{
      id: initial.id, parentId: null, depth: 0, handle: author.handle, body: initial.body, status: 'pending',
    }]);
    expect(queued).toMatchObject({ threadId: created.thread.id, pageId: null, forumId: 'site', parentId: initial.id, depth: 1 });
    const managementQueue = z.array(commentResponseSchema).parse(await (await api('/api/management/contributions', owner)).json());
    expect(managementQueue.find((entry) => entry.id === reply)?.ancestors).toEqual(queued?.ancestors);
    expect((await api('/api/management/contributions', moderator)).status).toBe(403);
    await review(reply, moderator);
    expect((await api(`/api/comments/${reply}/replies`, moderator)).status).toBe(404);
    await review(initial.id, owner, 'publish', true);
    expect((await discussion(`/api/comments/${initial.id}/replies`, moderator)).comments[0]).toMatchObject({ id: reply, status: 'published' });
    await db.prepare('UPDATE sessions SET authenticated_at=? WHERE user_id=?').bind(now() - 301, moderator.id).run();
    expect((await api('/api/moderation', moderator)).status).toBe(403);
  });
});

describe('immutable nesting, sibling pagination and private ancestry', () => {
  it('persists nested replies through depth 16 and explicitly rejects deeper/reparented replies', async () => {
    const author = await member('depth-author');
    const observer = await member('depth-observer');
    let parentId = await root(author);
    const ids = [parentId];
    for (let depth = 1; depth < DISCUSSION_MAX_DEPTH; depth++) {
      parentId = await child(parentId, author, 'published', `Synthetic published level ${depth}.`);
      ids.push(parentId);
    }
    const response = await api(`/api/comments/${parentId}/replies`, observer, { method: 'POST', body: { body: 'A depth-sixteen synthetic reply.' } });
    expect(response.status).toBe(201);
    const last = commentResponseSchema.parse(await response.json());
    expect(last).toMatchObject({ parentId, depth: 16, threadId: 'page-home', status: 'pending' });
    ids.push(last.id);
    expect((await discussion(`/api/comments/${parentId}/replies`, observer)).comments[0]?.id).toBe(last.id);
    expect((await discussion(`/api/comments/${parentId}/replies`, author)).comments).toHaveLength(0);
    const rejected = await api(`/api/comments/${last.id}/replies`, observer, { method: 'POST', body: { body: 'This level-seventeen reply must not save.' } });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: expect.stringContaining('depth 16') });
    expect((await api(`/api/comments/${last.id}/replies`, observer, { method: 'POST', body: { body: 'A malicious attempted reparent.', parentId: ids[0], depth: 1 } })).status).toBe(400);
    const stored = (await db.prepare('SELECT id,parent_id,depth FROM discussion_nodes ORDER BY depth').all()).results;
    expect(stored).toEqual(ids.map((id, depth) => ({ id, parent_id: depth ? ids[depth - 1] : null, depth })));
    expect(() => db.sqlite.exec(`UPDATE discussion_nodes SET parent_id='${ids[0]}' WHERE id='${last.id}'`)).toThrow('immutable');
    const otherRoot = await root(author, 'identity-model');
    expect(() => db.sqlite.prepare('INSERT INTO discussion_nodes (id,thread_id,parent_id,depth,created_at) VALUES (?,?,?,?,?)')
      .run(crypto.randomUUID(), 'page-home', otherRoot, 1, now())).toThrow('Invalid discussion ancestry');
  });

  it('never leaks a pending/hidden ancestor, title, child or report target to another member', async () => {
    const author = await member('private-parent');
    const descendantAuthor = await member('private-descendant');
    const reviewer = await member('private-reviewer', 'moderator');
    const seeded = await seededQuestion(author, 'site', 'pending', 'Private synthetic initial title');
    const descendant = await child(seeded.id, descendantAuthor, 'published', 'A published child behind a private parent.');
    const grandchild = await child(descendant, author, 'published', 'A published grandchild behind a private parent.');
    for (const path of [`/api/threads/${seeded.threadId}`, `/api/comments/${seeded.id}/replies`, `/api/comments/${descendant}/replies`, `/api/comments/${grandchild}/replies`]) {
      const denied = await api(path, descendantAuthor);
      expect(denied.status, path).toBe(404);
      expect(JSON.stringify(await denied.json())).not.toContain('Private synthetic initial title');
    }
    expect((await api(`/api/comments/${descendant}/report`, descendantAuthor, { method: 'POST', body: { reason: 'A synthetic unavailable branch report.' } })).status).toBe(404);
    expect((await api(`/api/comments/${descendant}/replies`, descendantAuthor, { method: 'POST', body: { body: 'A reply behind an unavailable parent.' } })).status).toBe(404);
    await review(seeded.id, reviewer);
    expect((await discussion(`/api/comments/${descendant}/replies`, descendantAuthor)).comments.map((entry) => entry.id)).toEqual([grandchild]);
    await review(seeded.id, reviewer, 'hide');
    expect((await api(`/api/comments/${descendant}/replies`, descendantAuthor)).status).toBe(404);
    expect((await discussion(`/api/threads/${seeded.threadId}`, author)).comments[0]?.status).toBe('hidden');
    expect((await api(`/api/comments/${descendant}/replies`, author, { method: 'POST', body: { body: 'A reply on an explicitly hidden branch.' } })).status).toBe(400);
    expect(forumPageSchema.parse(await (await api('/api/forums/site', descendantAuthor)).json()).threads).toEqual([]);
  });

  it('paginates root posts and direct siblings without duplicate IDs, missing parents or reordering', async () => {
    const author = await member('pagination-author');
    const observer = await member('pagination-observer');
    const time = now() - 1000;
    const rootIds = [];
    for (let index = 0; index < 35; index++) rootIds.push(await root(author, 'home', 'published', `Synthetic root post ${index}.`, time));
    await root(author, 'home', 'hidden', 'A private root excluded from the cursor.', time + 1);
    const first = await discussion('/api/discussions/home', observer);
    expect(first.comments).toHaveLength(30);
    expect(first.nextCursor).not.toBeNull();
    const second = await discussion(`/api/threads/page-home?cursor=${encodeURIComponent(first.nextCursor || '')}`, observer);
    expect(second.comments).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect([...first.comments, ...second.comments].map((entry) => entry.id)).toEqual([...rootIds].sort().reverse());
    const parentId = rootIds[0];
    if (!parentId) throw new Error('Missing pagination parent.');
    const childIds = [];
    for (let index = 0; index < 35; index++) childIds.push(await child(parentId, author, 'published', `Synthetic sibling reply ${index}.`, time));
    await child(parentId, author, 'pending', 'A private pending sibling excluded from the cursor.', time);
    const children = await discussion(`/api/comments/${parentId}/replies`, observer);
    const more = await discussion(`/api/comments/${parentId}/replies?cursor=${encodeURIComponent(children.nextCursor || '')}`, observer);
    expect(children.comments).toHaveLength(30);
    expect(more.comments).toHaveLength(5);
    expect(more.nextCursor).toBeNull();
    const all = [...children.comments, ...more.comments];
    expect(all.map((entry) => entry.id)).toEqual([...childIds].sort());
    expect(all.every((entry) => entry.parentId === parentId && entry.depth === 1 && entry.threadId === first.thread.id)).toBe(true);
    for (const cursor of ['', 'not-a-cursor', '1_not-a-uuid', '-1_00000000-0000-4000-8000-000000000001']) {
      expect((await api(`/api/comments/${parentId}/replies?cursor=${encodeURIComponent(cursor)}`, observer)).status).toBe(400);
    }
  });

  it('paginates independent threads with author-only pending titles and stable cursor ties', async () => {
    const author = await member('thread-pagination-author');
    const observer = await member('thread-pagination-observer');
    const ids = [];
    for (let index = 0; index < 35; index++) ids.push((await seededQuestion(author, 'site', 'published', `Synthetic question ${index}`, now() - 1000)).threadId);
    await seededQuestion(author, 'site', 'pending', 'Private pagination title');
    const first = forumPageSchema.parse(await (await api('/api/forums/site', observer)).json());
    const second = forumPageSchema.parse(await (await api(`/api/forums/site?cursor=${encodeURIComponent(first.nextCursor || '')}`, observer)).json());
    expect(first.threads).toHaveLength(30);
    expect(second.threads).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    const all = [...first.threads, ...second.threads].map((entry) => entry.id);
    expect(new Set(all).size).toBe(35);
    expect(new Set(all)).toEqual(new Set(ids));
    expect(JSON.stringify([...first.threads, ...second.threads])).not.toContain('Private pagination title');
  });
});

describe('account export, deletion and write races', () => {
  it('exports the member relationships and erases personal content while retaining other replies', async () => {
    const author = await member('deleted-question-author');
    const other = await member('remaining-replier');
    const moderator = await member('deletion-reviewer', 'moderator');
    const created = await question(author, 'site', 'An initial title that must be erased');
    const initial = created.comments[0];
    if (!initial) throw new Error('Missing initial post.');
    await review(initial.id, moderator);
    const reply = await child(initial.id, other, 'published', 'Another member keeps this published reply.');
    const nested = await child(reply, author, 'published', 'Deleted author personal nested body.');
    const survivor = await child(nested, other, 'published', 'Another member keeps this deeper published reply.');
    await db.prepare('INSERT INTO reports (comment_id,reporter_id,reason,created_at) VALUES (?,?,?,?)')
      .bind(reply, moderator.id, 'Preserve this report on another member.', now()).run();
    const exported = await api('/api/account/export', author);
    expect(exported.status).toBe(200);
    const data = await exported.json() as { contributions: Record<string, unknown>[] };
    expect(data.contributions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: initial.id, thread_id: created.thread.id, forum_id: 'site', parent_id: null, depth: 0, title: created.thread.title, page_id: null }),
      expect.objectContaining({ id: nested, thread_id: created.thread.id, parent_id: reply, depth: 2, title: null }),
    ]));
    expect(JSON.stringify(data)).not.toContain('Another member keeps');
    const deleted = await api('/api/account', author, { method: 'DELETE', body: { confirmHandle: author.handle } });
    expect(deleted.status).toBe(200);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM comments WHERE author_id=?').bind(author.id).first('count')).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM users WHERE id=?').bind(author.id).first('count')).toBe(0);
    const thread = await discussion(`/api/threads/${created.thread.id}`, other);
    expect(thread.thread.title).toBe('Removed question');
    expect(thread.comments[0]).toMatchObject({ id: initial.id, body: '', status: 'removed', handle: 'Removed contribution', own: false });
    expect((await discussion(`/api/comments/${initial.id}/replies`, other)).comments[0]?.id).toBe(reply);
    expect((await discussion(`/api/comments/${reply}/replies`, other)).comments[0]).toMatchObject({ id: nested, body: '', status: 'removed' });
    expect((await discussion(`/api/comments/${nested}/replies`, other)).comments[0]).toMatchObject({ id: survivor, parentId: nested, depth: 3 });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM reports WHERE comment_id=?').bind(reply).first('count')).toBe(1);
    const nodes = (await db.prepare('SELECT * FROM discussion_nodes').all()).results;
    expect(JSON.stringify(nodes)).not.toContain(author.id);
    expect(JSON.stringify(nodes)).not.toContain(author.handle);
    expect(JSON.stringify(nodes)).not.toContain(created.thread.title);
    expect(JSON.stringify(nodes)).not.toContain('personal nested body');
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('retains a deleted pending/hidden ancestor as an inaccessible barrier, even after earlier publication', async () => {
    const other = await member('private-surviving-child');
    for (const status of ['pending', 'hidden'] as const) {
      const author = await member(`private-deleted-${status}`);
      const seeded = await seededQuestion(author, 'site', 'published', `Private deleted ${status} title`);
      const reply = await child(seeded.id, other, 'published', `An unavailable ${status} branch child.`);
      const ownReply = await child(reply, other, 'pending', `An unavailable ${status} branch pending child.`);
      await db.prepare('UPDATE comments SET status=? WHERE id=?').bind(status, seeded.id).run();
      expect((await api('/api/account', author, { method: 'DELETE', body: { confirmHandle: author.handle } })).status).toBe(200);
      expect(await db.prepare('SELECT removed_visible FROM discussion_nodes WHERE id=?').bind(seeded.id).first('removed_visible')).toBe(0);
      for (const path of [`/api/threads/${seeded.threadId}`, `/api/comments/${seeded.id}/replies`, `/api/comments/${reply}/replies`, `/api/comments/${ownReply}/replies`]) {
        expect((await api(path, other)).status, path).toBe(404);
      }
      expect(forumPageSchema.parse(await (await api('/api/forums/site', other)).json()).threads).toEqual([]);
      expect(await db.prepare('SELECT parent_id FROM discussion_nodes WHERE id=?').bind(reply).first('parent_id')).toBe(seeded.id);
    }
  });

  it('clears a removed root title/reports atomically without reparenting published replies', async () => {
    const author = await member('removed-post-author');
    const other = await member('removed-post-other');
    const seeded = await seededQuestion(author);
    const reply = await child(seeded.id, other);
    await db.prepare('INSERT INTO reports (comment_id,reporter_id,reason,created_at) VALUES (?,?,?,?)')
      .bind(seeded.id, other.id, 'Synthetic report removed with contribution.', now()).run();
    expect((await api(`/api/comments/${seeded.id}`, author, { method: 'DELETE' })).status).toBe(200);
    expect(await db.prepare('SELECT body,title,status FROM comments WHERE id=?').bind(seeded.id).first()).toEqual({ body: '', title: null, status: 'removed' });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM reports').first('count')).toBe(0);
    expect((await discussion(`/api/threads/${seeded.threadId}`, other)).thread.title).toBe('Removed question');
    expect((await discussion(`/api/comments/${seeded.id}/replies`, other)).comments[0]).toMatchObject({ id: reply, parentId: seeded.id, depth: 1 });
    const leaf = await root(author, 'identity-model');
    expect((await api(`/api/comments/${leaf}`, author, { method: 'DELETE' })).status).toBe(200);
    expect((await discussion('/api/discussions/identity-model', other)).comments).toEqual([]);
  });

  it('rechecks parent visibility and the live session in the same reply insertion transaction', async () => {
    const author = await member('reply-race-author');
    const parent = await root(author);
    const originalBatch = db.batch.bind(db);
    vi.spyOn(db, 'batch').mockImplementationOnce(async (statements) => {
      db.sqlite.prepare("UPDATE comments SET status='hidden' WHERE id=?").run(parent);
      return originalBatch(statements);
    });
    const hidden = await api(`/api/comments/${parent}/replies`, author, { method: 'POST', body: { body: 'A reply racing a hidden parent.' } });
    expect(hidden.status).toBe(409);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM discussion_nodes WHERE parent_id=?').bind(parent).first('count')).toBe(0);
    await db.prepare("UPDATE comments SET status='published' WHERE id=?").bind(parent).run();
    vi.spyOn(db, 'batch').mockImplementationOnce(async (statements) => {
      db.sqlite.prepare('DELETE FROM sessions WHERE user_id=?').run(author.id);
      return originalBatch(statements);
    });
    const revoked = await api(`/api/comments/${parent}/replies`, author, { method: 'POST', body: { body: 'A reply racing session revocation.' } });
    expect(revoked.status).toBe(409);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM comments').first('count')).toBe(1);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM discussion_nodes').first('count')).toBe(1);
  });

  it('creates no thread/node/audit record when owner permission is revoked before announcement commit', async () => {
    const owner = await member('announcement-race-owner', 'learner', MANAGEMENT_GITHUB_USER_ID);
    const originalBatch = db.batch.bind(db);
    vi.spyOn(db, 'batch').mockImplementationOnce(async (statements) => {
      db.sqlite.prepare('DELETE FROM social_identities WHERE user_id=?').run(owner.id);
      return originalBatch(statements);
    });
    const response = await api('/api/forums/announcements/threads', owner, { method: 'POST', body: { title: 'A raced synthetic announcement', body: 'This announcement must not be committed.' } });
    expect(response.status).toBe(409);
    for (const table of ['discussion_threads', 'discussion_nodes', 'comments', 'moderation_audit']) {
      expect(await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first('count'), table).toBe(0);
    }
  });

  it('serializes simultaneous page posting into one conversation without copying roots', async () => {
    const first = await member('concurrent-page-first');
    const second = await member('concurrent-page-second');
    const responses = await Promise.all([
      api('/api/discussions/identity-model', first, { method: 'POST', body: { body: 'First concurrent synthetic page contribution.' } }),
      api('/api/discussions/identity-model', second, { method: 'POST', body: { body: 'Second concurrent synthetic page contribution.' } }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const comments = await Promise.all(responses.map(async (response) => commentResponseSchema.parse(await response.json())));
    expect(new Set(comments.map((comment) => comment.id)).size).toBe(2);
    expect(comments.every((comment) => comment.threadId === 'page-identity-model' && comment.depth === 0 && comment.parentId === null)).toBe(true);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM discussion_threads WHERE page_id='identity-model'").first('count')).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM discussion_nodes WHERE thread_id='page-identity-model'").first('count')).toBe(2);
    expect((await discussion('/api/discussions/identity-model', first)).comments.map((comment) => comment.id)).toEqual([comments[0]?.id]);
    expect((await discussion('/api/threads/page-identity-model', second)).comments.map((comment) => comment.id)).toEqual([comments[1]?.id]);
  });

  it('rolls back an entire new question when its initial content insert fails', async () => {
    const author = await member('question-rollback-author');
    db.sqlite.exec("CREATE TRIGGER fail_initial_post BEFORE INSERT ON comments WHEN NEW.title IS NOT NULL BEGIN SELECT RAISE(ABORT, 'Injected initial-post failure'); END;");
    const failed = await api('/api/forums/site/threads', author, { method: 'POST', body: {
      title: 'A question that must roll back', body: 'Its initial post must not leave an orphan thread.',
    } });
    expect(failed.status).toBe(503);
    for (const table of ['discussion_threads', 'discussion_nodes', 'comments', 'moderation_audit']) {
      expect(await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first('count')).toBe(0);
    }
    db.sqlite.exec('DROP TRIGGER fail_initial_post;');
    expect((await question(author)).comments).toHaveLength(1);
  });

  it('rechecks the full ancestor path at report insertion, not only during its preliminary read', async () => {
    const author = await member('report-race-author');
    const reporter = await member('report-race-reporter');
    const parent = await root(author);
    const reply = await child(parent, author);
    const originalPrepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      if (sql.includes('INSERT INTO reports (comment_id')) db.sqlite.prepare("UPDATE comments SET status='hidden' WHERE id=?").run(parent);
      return originalPrepare(sql);
    });
    const result = await api(`/api/comments/${reply}/report`, reporter, { method: 'POST', body: { reason: 'A report racing an ancestor visibility change.' } });
    expect(result.status).toBe(409);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM reports').first('count')).toBe(0);
  });

  it('does not clear reports or add an audit if an owner loses review access before commit', async () => {
    const owner = await member('review-race-owner', 'learner', MANAGEMENT_GITHUB_USER_ID);
    const author = await member('review-race-author');
    const reporter = await member('review-race-reporter');
    const id = await root(author);
    await review(id, owner, 'publish', true);
    await db.prepare('INSERT INTO reports (comment_id,reporter_id,reason,created_at) VALUES (?,?,?,?)')
      .bind(id, reporter.id, 'Do not clear this report after access revocation.', now()).run();
    const originalBatch = db.batch.bind(db);
    vi.spyOn(db, 'batch').mockImplementationOnce(async (statements) => {
      db.sqlite.prepare('DELETE FROM social_identities WHERE user_id=?').run(owner.id);
      return originalBatch(statements);
    });
    expect((await api(`/api/management/contributions/${id}`, owner, { method: 'POST', body: { action: 'publish' } })).status).toBe(409);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM reports WHERE comment_id=?').bind(id).first('count')).toBe(1);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM moderation_audit WHERE comment_id=?').bind(id).first('count')).toBe(1);
  });

  it('does not expose a non-root hidden branch when its author is deleted', async () => {
    const rootAuthor = await member('non-root-context-owner');
    const deletedAuthor = await member('non-root-deleted-author');
    const other = await member('non-root-surviving-author');
    const parent = await root(rootAuthor);
    const hidden = await child(parent, deletedAuthor, 'hidden', 'Deleted hidden non-root personal content.');
    const surviving = await child(hidden, other, 'published', 'A published child that must remain unavailable.');
    expect((await api('/api/account', deletedAuthor, { method: 'DELETE', body: { confirmHandle: deletedAuthor.handle } })).status).toBe(200);
    expect((await discussion('/api/discussions/home', other)).comments[0]).toMatchObject({ id: parent, replyCount: 0 });
    expect((await discussion(`/api/comments/${parent}/replies`, other)).comments).toEqual([]);
    expect((await api(`/api/comments/${surviving}/replies`, other)).status).toBe(404);
    expect(await db.prepare('SELECT parent_id FROM discussion_nodes WHERE id=?').bind(surviving).first('parent_id')).toBe(hidden);
    expect(await db.prepare('SELECT body FROM comments WHERE id=?').bind(surviving).first('body')).toBe('A published child that must remain unavailable.');
  });

  it('rolls back account deletion and placeholder changes together, then preserves the successful delete', async () => {
    const author = await member('atomic-delete-author');
    const other = await member('atomic-delete-other');
    const parent = await root(author);
    const reply = await child(parent, other);
    db.sqlite.exec("CREATE TRIGGER fail_account_delete AFTER DELETE ON users BEGIN SELECT RAISE(ABORT, 'Injected deletion failure'); END;");
    const failed = await api('/api/account', author, { method: 'DELETE', body: { confirmHandle: author.handle } });
    expect(failed.status).toBe(503);
    expect(await db.prepare('SELECT body,status FROM comments WHERE id=?').bind(parent).first()).toEqual({ body: 'A synthetic page discussion root.', status: 'published' });
    expect(await db.prepare('SELECT removed_visible FROM discussion_nodes WHERE id=?').bind(parent).first('removed_visible')).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM users WHERE id=?').bind(author.id).first('count')).toBe(1);
    db.sqlite.exec('DROP TRIGGER fail_account_delete;');
    const deleted = await api('/api/account', author, { method: 'DELETE', body: { confirmHandle: author.handle } });
    expect(deleted.status).toBe(200);
    expect((await discussion('/api/discussions/home', other)).comments[0]).toMatchObject({ id: parent, status: 'removed' });
    expect((await discussion(`/api/comments/${parent}/replies`, other)).comments[0]?.id).toBe(reply);
    expect((await api('/api/account', author, { method: 'DELETE', body: { confirmHandle: author.handle } })).status).toBe(401);
  });

  it('does not delete an account after its recent session was revoked or aged before commit', async () => {
    const author = await member('delete-session-race');
    const parent = await root(author);
    const originalBatch = db.batch.bind(db);
    vi.spyOn(db, 'batch').mockImplementationOnce(async (statements) => {
      db.sqlite.prepare('UPDATE sessions SET authenticated_at=? WHERE user_id=?').run(now() - 301, author.id);
      return originalBatch(statements);
    });
    expect((await api('/api/account', author, { method: 'DELETE', body: { confirmHandle: author.handle } })).status).toBe(409);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM users WHERE id=?').bind(author.id).first('count')).toBe(1);
    expect(await db.prepare('SELECT status FROM comments WHERE id=?').bind(parent).first('status')).toBe('published');
    expect(await db.prepare('SELECT removed_visible FROM discussion_nodes WHERE id=?').bind(parent).first('removed_visible')).toBe(0);
  });

  it('serializes simultaneous account deletion without losing another member\'s reply context', async () => {
    const author = await member('double-delete-author');
    const other = await member('double-delete-other');
    const parent = await root(author);
    const reply = await child(parent, other);
    const responses = await Promise.all([
      api('/api/account', author, { method: 'DELETE', body: { confirmHandle: author.handle } }),
      api('/api/account', author, { method: 'DELETE', body: { confirmHandle: author.handle } }),
    ]);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.some((response) => response.status === 401 || response.status === 409)).toBe(true);
    expect((await discussion(`/api/comments/${parent}/replies`, other)).comments[0]).toMatchObject({ id: reply, parentId: parent });
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('prunes fully removed branches but keeps every ancestor of another member\'s private post', async () => {
    const author = await member('pruned-branch-author');
    const other = await member('pruned-branch-other');
    const emptyRoot = await root(author);
    const emptyChild = await child(emptyRoot, author);
    await child(emptyChild, author);
    const retainedRoot = await root(author);
    const retainedParent = await child(retainedRoot, author, 'hidden');
    const retainedChild = await child(retainedParent, other, 'pending', 'Keep another member private pending content.');
    const deleted = await api('/api/account', author, { method: 'DELETE', body: { confirmHandle: author.handle } });
    expect(deleted.status).toBe(200);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM discussion_nodes WHERE id IN (?,?)').bind(emptyRoot, emptyChild).first('count')).toBe(0);
    expect((await db.prepare('SELECT id,parent_id,depth FROM discussion_nodes ORDER BY depth').all()).results).toEqual([
      { id: retainedRoot, parent_id: null, depth: 0 },
      { id: retainedParent, parent_id: retainedRoot, depth: 1 },
      { id: retainedChild, parent_id: retainedParent, depth: 2 },
    ]);
    expect((await api(`/api/comments/${retainedChild}/replies`, other)).status).toBe(404);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('prunes an empty soft-removed conversation without deleting UUIDs or review history', async () => {
    const author = await member('soft-prune-author');
    const initial = await seededQuestion(author);
    const reply = await child(initial.id, author);
    const nested = await child(reply, author);
    for (const id of [initial.id, reply, nested]) {
      expect((await api(`/api/comments/${id}`, author, { method: 'DELETE' })).status).toBe(200);
    }
    expect(await db.prepare('SELECT COUNT(*) AS count FROM discussion_nodes WHERE thread_id=?').bind(initial.threadId).first('count')).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM comments WHERE id IN (?,?,?) AND body=? AND title IS NULL AND status=?')
      .bind(initial.id, reply, nested, '', 'removed').first('count')).toBe(3);
    expect((await api(`/api/threads/${initial.threadId}`, author)).status).toBe(404);
    expect(forumPageSchema.parse(await (await api('/api/forums/site', author)).json()).threads).toEqual([]);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('leaves reports and topology unchanged on an already-removed post or a revoked removal session', async () => {
    const author = await member('remove-race-author');
    const reporter = await member('remove-race-reporter');
    const removed = await root(author, 'home', 'removed', 'An original legacy removed body stays unchanged.');
    const published = await root(author);
    for (const id of [removed, published]) {
      await db.prepare('INSERT INTO reports (comment_id,reporter_id,reason,created_at) VALUES (?,?,?,?)')
        .bind(id, reporter.id, 'Preserve this report unless removal succeeds.', now()).run();
    }
    expect((await api(`/api/comments/${removed}`, author, { method: 'DELETE' })).status).toBe(404);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM reports WHERE comment_id=?').bind(removed).first('count')).toBe(1);
    expect(await db.prepare('SELECT body FROM comments WHERE id=?').bind(removed).first('body')).toBe('An original legacy removed body stays unchanged.');
    const originalBatch = db.batch.bind(db);
    vi.spyOn(db, 'batch').mockImplementationOnce(async (statements) => {
      db.sqlite.prepare('DELETE FROM sessions WHERE user_id=?').run(author.id);
      return originalBatch(statements);
    });
    expect((await api(`/api/comments/${published}`, author, { method: 'DELETE' })).status).toBe(404);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM reports WHERE comment_id=?').bind(published).first('count')).toBe(1);
    expect(await db.prepare('SELECT status FROM comments WHERE id=?').bind(published).first('status')).toBe('published');
    expect(await db.prepare('SELECT COUNT(*) AS count FROM discussion_nodes').first('count')).toBe(2);
  });
});
