import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { commentAncestorSchema } from '../shared/api-schemas';
import { DISCUSSION_MAX_DEPTH, DISCUSSION_PAGE_SIZE, PRIVACY_VERSION, TERMS_VERSION } from '../shared/contracts';
import type { Comment, DiscussionThread, ThreadSummary } from '../shared/contracts';
import { forumCategories, forumPages, pageDiscussion, requireForum } from './forum-catalog';
import { pruneEmptyDiscussionBranches } from './discussion-lifecycle';
import { canManageSite, MANAGEMENT_GITHUB_USER_ID, requireReviewAccess, requireSiteManagement } from './management-access';
import { FRESH_AUTH_SECONDS, now, rateLimit, requireCommunityEnabled, requireSession, sha256 } from './security';
import { commentSchema, containsLikelySecret, hasDisallowedControl, questionThreadSchema, readJson } from './validation';
import type { AppContext, AppEnv, SessionRow } from './types';

interface CommentRow {
  id: string;
  thread_id: string;
  parent_id: string | null;
  depth: number;
  created_at: number;
  author_id: string | null;
  handle: string | null;
  body: string | null;
  status: Comment['status'] | null;
  kind: DiscussionThread['kind'];
  page_id: string | null;
  forum_id: string | null;
  root_id: string | null;
  thread_title: string | null;
  reply_count: number;
  hidden_ancestors?: number;
  reports?: number;
  report_reasons?: string;
  ancestors?: string;
}

function readable(node: string, content: string): string {
  return `COALESCE((${content}.status = 'published' OR
    (${content}.author_id = (SELECT user_id FROM viewer) AND ${content}.status IN ('pending', 'hidden')) OR
    (COALESCE(${content}.status, 'removed') = 'removed' AND ${node}.removed_visible = 1
      AND EXISTS (SELECT 1 FROM discussion_nodes remaining WHERE remaining.parent_id = ${node}.id))), 0)`;
}

const ancestorsSql = `WITH RECURSIVE viewer(user_id) AS (VALUES (?)), ancestry AS (
  SELECT n.*, c.author_id, c.status FROM discussion_nodes n LEFT JOIN comments c ON c.id = n.id WHERE n.id = ?
  UNION ALL
  SELECT n.*, c.author_id, c.status FROM discussion_nodes n
    JOIN ancestry a ON n.id = a.parent_id AND n.thread_id = a.thread_id AND n.depth = a.depth - 1
    LEFT JOIN comments c ON c.id = n.id WHERE a.depth > 0
)`;

function visiblePath(node: string): string {
  return `(SELECT COUNT(*) FROM ancestry) = ${node}.depth + 1
    AND NOT EXISTS (SELECT 1 FROM ancestry a WHERE NOT ${readable('a', 'a')})`;
}

const commentColumns = `n.id, n.thread_id, n.parent_id, n.depth, n.created_at,
  c.author_id, c.body, c.status, u.handle, t.kind, t.page_id, t.forum_id, t.root_id, root.title AS thread_title,
  (SELECT COUNT(*) FROM discussion_nodes child LEFT JOIN comments content ON content.id = child.id
    WHERE child.parent_id = n.id AND ${readable('child', 'content')}) AS reply_count`;

const commentJoins = `FROM discussion_nodes n JOIN discussion_threads t ON t.id = n.thread_id
  LEFT JOIN comments c ON c.id = n.id LEFT JOIN users u ON u.id = c.author_id
  LEFT JOIN comments root ON root.id = t.root_id`;

function threadFromRow(row: CommentRow): DiscussionThread {
  if (row.kind === 'page' && row.page_id) return pageDiscussion(row.page_id);
  const forum = requireForum(row.forum_id || '');
  return {
    id: row.thread_id, forumId: forum.id, pageId: null, kind: row.kind,
    title: row.thread_title || (row.kind === 'announcement' ? 'Removed announcement' : 'Removed question'),
    rootCommentId: row.root_id,
  };
}

function toComment(c: AppContext, row: CommentRow): Comment {
  const thread = threadFromRow(row);
  const removed = !row.status || row.status === 'removed';
  return {
    id: row.id, pageId: thread.pageId, threadId: thread.id, forumId: thread.forumId,
    threadTitle: thread.title, threadKind: thread.kind, parentId: row.parent_id, depth: row.depth,
    replyCount: row.reply_count, handle: removed ? 'Removed contribution' : row.handle || 'Deleted member',
    body: removed ? '' : row.body || '', status: removed ? 'removed' : row.status || 'removed',
    createdAt: row.created_at, own: !removed && row.author_id === c.get('session')?.user_id,
    ...(row.reports === undefined ? {} : { reports: row.reports }),
    ...(row.report_reasons === undefined ? {} : { reportReasons: z.array(z.string()).max(10).parse(JSON.parse(row.report_reasons)) }),
    ...(row.ancestors === undefined ? {} : { ancestors: z.array(commentAncestorSchema).max(DISCUSSION_MAX_DEPTH).parse(JSON.parse(row.ancestors)) }),
  };
}

function cursorValues(cursor: string | undefined, ascending = false): [number, string] {
  if (cursor === undefined) return ascending ? [0, ''] : [Number.MAX_SAFE_INTEGER, '\uffff'];
  const match = /^(\d{1,12})_([a-f0-9-]{36})$/u.exec(cursor);
  if (!match?.[1] || !match[2] || !z.uuid().safeParse(match[2]).success) {
    throw new HTTPException(400, { message: 'Invalid discussion cursor.' });
  }
  return [Number(match[1]), match[2]];
}

function commentPage(c: AppContext, thread: DiscussionThread, rows: CommentRow[]) {
  const comments = rows.slice(0, DISCUSSION_PAGE_SIZE);
  const last = comments.at(-1);
  return {
    thread, comments: comments.map((row) => toComment(c, row)),
    nextCursor: rows.length > DISCUSSION_PAGE_SIZE && last ? `${last.created_at}_${last.id}` : null,
  };
}

function visibleCommentStatement(c: AppContext, id: string): D1PreparedStatement {
  const session = requireSession(c, { currentConsent: true });
  return c.env.DB.prepare(`${ancestorsSql} SELECT ${commentColumns},
    (SELECT COUNT(*) FROM ancestry WHERE status = 'hidden') AS hidden_ancestors
    ${commentJoins} WHERE n.id = ? AND ${visiblePath('n')}`)
    .bind(session.user_id, id, id);
}

async function visibleComment(c: AppContext, id: string): Promise<CommentRow> {
  const row = await visibleCommentStatement(c, id).first<CommentRow>();
  if (!row) throw new HTTPException(404, { message: 'Contribution not found.' });
  threadFromRow(row);
  return row;
}

let ownerIdentityHash: Promise<string> | undefined;
function pinnedOwnerHash(): Promise<string> {
  ownerIdentityHash ??= sha256(JSON.stringify(['github', 'https://github.com', MANAGEMENT_GITHUB_USER_ID]));
  return ownerIdentityHash;
}

function liveGuard(session: SessionRow, time: number, options: {
  consent?: boolean; fresh?: boolean; privilege?: 'owner' | 'review'; ownerHash?: string;
} = {}): { sql: string; values: (string | number)[] } {
  const conditions = ['s.token_hash = ?', 's.user_id = ?', 's.csrf_token = ?', 's.expires_at > ?'];
  const values: (string | number)[] = [session.token_hash, session.user_id, session.csrf_token, time];
  if (options.consent !== false) {
    conditions.push('u.terms_version = ?', 'u.privacy_version = ?');
    values.push(TERMS_VERSION, PRIVACY_VERSION);
  }
  if (options.fresh) {
    conditions.push('s.authenticated_at >= ?');
    values.push(time - FRESH_AUTH_SECONDS);
  }
  if (options.privilege) {
    const owner = "EXISTS (SELECT 1 FROM social_identities identity WHERE identity.user_id = u.id AND identity.provider = 'github' AND identity.identity_hash = ?)";
    conditions.push(options.privilege === 'review' ? `(u.role = 'moderator' OR ${owner})` : owner);
    values.push(options.ownerHash || '');
  }
  return {
    sql: `EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id WHERE ${conditions.join(' AND ')})`,
    values,
  };
}

async function contributionRateLimits(c: AppContext, session: SessionRow): Promise<void> {
  await rateLimit(c, 'comment-account', 12, 3600, session.user_id);
  await rateLimit(c, 'comment-network', 30, 3600);
}

async function insertedComment(c: AppContext, id: string): Promise<Comment> {
  const row = await visibleCommentStatement(c, id).first<CommentRow>();
  if (!row) throw new HTTPException(409, { message: 'The discussion or account changed while saving. Refresh before posting again.' });
  return toComment(c, row);
}

async function readPage(c: AppContext, pageId: string) {
  const session = requireSession(c, { currentConsent: true });
  const thread = pageDiscussion(pageId);
  const [before, beforeId] = cursorValues(c.req.query('cursor'));
  const rows = await c.env.DB.prepare(`WITH viewer(user_id) AS (VALUES (?))
    SELECT ${commentColumns} ${commentJoins}
    WHERE n.thread_id = ? AND n.parent_id IS NULL AND ${readable('n', 'c')}
    AND (n.created_at < ? OR (n.created_at = ? AND n.id < ?))
    ORDER BY n.created_at DESC, n.id DESC LIMIT ${DISCUSSION_PAGE_SIZE + 1}`)
    .bind(session.user_id, thread.id, before, before, beforeId).all<CommentRow>();
  return commentPage(c, thread, rows.results);
}

export const discussions = new Hono<AppEnv>();

discussions.get('/forums', async (c) => {
  requireSession(c, { currentConsent: true });
  return c.json({ categories: forumCategories, canAnnounce: await canManageSite(c) });
});

discussions.get('/community/activity', async (c) => {
  const session = requireSession(c, { currentConsent: true });
  const view = c.req.query('view') || 'mine';
  if (view !== 'mine' && view !== 'replies') throw new HTTPException(400, { message: 'Choose your contributions or replies.' });
  const selection = view === 'mine' ? 'c.author_id = ?'
    : 'c.author_id != ? AND EXISTS (SELECT 1 FROM comments parent WHERE parent.id = n.parent_id AND parent.author_id = ?)';
  const values = view === 'mine' ? [session.user_id] : [session.user_id, session.user_id];
  const rows = await c.env.DB.prepare(`WITH viewer(user_id) AS (VALUES (?))
    SELECT ${commentColumns} ${commentJoins}
    WHERE ${selection} AND ${readable('n', 'c')}
    AND (WITH RECURSIVE path AS (
      SELECT a.* FROM discussion_nodes a WHERE a.id = n.id
      UNION ALL SELECT a.* FROM discussion_nodes a JOIN path p ON a.id = p.parent_id
        AND a.thread_id = p.thread_id AND a.depth = p.depth - 1 WHERE p.depth > 0
    ) SELECT COUNT(*) = n.depth + 1 AND SUM(CASE WHEN ${readable('path', 'content')} THEN 0 ELSE 1 END) = 0
      FROM path LEFT JOIN comments content ON content.id = path.id)
    ORDER BY n.created_at DESC, n.id DESC LIMIT 30`).bind(session.user_id, ...values).all<CommentRow>();
  return c.json(rows.results.map((row) => toComment(c, row)));
});

discussions.get('/forums/:forumId', async (c) => {
  const session = requireSession(c, { currentConsent: true });
  const category = requireForum(c.req.param('forumId'));
  const pages = forumPages(category.id);
  const [before, beforeId] = cursorValues(c.req.query('cursor'));
  const results = await c.env.DB.batch<CommentRow & { root_posts: number; latest_post_at: number | null }>([
    c.env.DB.prepare(`WITH viewer(user_id) AS (VALUES (?))
      SELECT t.page_id, COUNT(n.id) AS root_posts, MAX(n.created_at) AS latest_post_at
      FROM discussion_threads t JOIN discussion_nodes n ON n.thread_id = t.id AND n.parent_id IS NULL
      LEFT JOIN comments c ON c.id = n.id
      WHERE t.kind = 'page' AND ${readable('n', 'c')} GROUP BY t.page_id`).bind(session.user_id),
    c.env.DB.prepare(`WITH viewer(user_id) AS (VALUES (?))
      SELECT ${commentColumns} ${commentJoins}
      WHERE t.forum_id = ? AND n.id = t.root_id AND ${readable('n', 'c')}
      AND (n.created_at < ? OR (n.created_at = ? AND n.id < ?))
      ORDER BY n.created_at DESC, n.id DESC LIMIT ${DISCUSSION_PAGE_SIZE + 1}`)
      .bind(session.user_id, category.id, before, before, beforeId),
  ]);
  const pageDiscussions = pages.map((thread): ThreadSummary => {
    const count = results[0]?.results.find((row) => row.page_id === thread.pageId);
    return { ...thread, rootPosts: count?.root_posts || 0, latestPostAt: count?.latest_post_at ?? null };
  });
  const rows = results[1]?.results || [];
  const roots = rows.slice(0, DISCUSSION_PAGE_SIZE);
  const last = roots.at(-1);
  return c.json({
    category, pageDiscussions,
    threads: roots.map((row): ThreadSummary => ({ ...threadFromRow(row), rootPosts: 1, latestPostAt: row.created_at })),
    nextCursor: rows.length > DISCUSSION_PAGE_SIZE && last ? `${last.created_at}_${last.id}` : null,
  });
});

discussions.get('/threads/:threadId', async (c) => {
  requireSession(c, { currentConsent: true });
  const id = c.req.param('threadId');
  if (id.startsWith('page-')) return c.json(await readPage(c, id.slice(5)));
  if (!z.uuid().safeParse(id).success) throw new HTTPException(404, { message: 'Discussion thread not found.' });
  const thread = await c.env.DB.prepare('SELECT root_id FROM discussion_threads WHERE id = ? AND kind != ?')
    .bind(id, 'page').first<{ root_id: string }>();
  if (!thread) throw new HTTPException(404, { message: 'Discussion thread not found.' });
  if (c.req.query('cursor') !== undefined) throw new HTTPException(400, { message: 'Use reply pagination within this thread.' });
  const root = await visibleComment(c, thread.root_id);
  return c.json(commentPage(c, threadFromRow(root), [root]));
});

discussions.get('/discussions/:pageId', async (c) => c.json(await readPage(c, c.req.param('pageId'))));

discussions.post('/discussions/:pageId', async (c) => {
  requireCommunityEnabled(c);
  const session = requireSession(c, { currentConsent: true });
  const thread = pageDiscussion(c.req.param('pageId'));
  const input = await readJson(c, commentSchema);
  await contributionRateLimits(c, session);
  const time = now();
  const guard = liveGuard(session, time);
  const id = crypto.randomUUID();
  const results = await c.env.DB.batch<{ id: string }>([
    c.env.DB.prepare(`INSERT OR IGNORE INTO discussion_threads (id, kind, page_id, created_at)
      SELECT ?, 'page', ?, ? WHERE ${guard.sql}`).bind(thread.id, thread.pageId, time, ...guard.values),
    c.env.DB.prepare(`INSERT INTO discussion_nodes (id, thread_id, parent_id, depth, created_at)
      SELECT ?, t.id, NULL, 0, ? FROM discussion_threads t WHERE t.id = ? AND ${guard.sql}`)
      .bind(id, time, thread.id, ...guard.values),
    c.env.DB.prepare(`INSERT INTO comments (id, page_id, author_id, body, status, created_at)
      SELECT n.id, t.page_id, ?, ?, 'pending', n.created_at
      FROM discussion_nodes n JOIN discussion_threads t ON t.id = n.thread_id WHERE n.id = ? RETURNING id`)
      .bind(session.user_id, input.body, id),
  ]);
  if (results[2]?.results[0]?.id !== id) {
    throw new HTTPException(409, { message: 'Your account changed before the contribution was saved. Sign in and retry.' });
  }
  return c.json(await insertedComment(c, id), 201);
});

discussions.post('/forums/:forumId/threads', async (c) => {
  requireCommunityEnabled(c);
  const category = requireForum(c.req.param('forumId'));
  const announcement = category.kind === 'announcements';
  const session = announcement ? await requireSiteManagement(c) : requireSession(c, { currentConsent: true });
  const input = await readJson(c, questionThreadSchema);
  await contributionRateLimits(c, session);
  const time = now();
  const guard = liveGuard(session, time, announcement ? { fresh: true, privilege: 'owner', ownerHash: await pinnedOwnerHash() } : {});
  const threadId = crypto.randomUUID();
  const id = crypto.randomUUID();
  const results = await c.env.DB.batch<{ id: string }>([
    c.env.DB.prepare(`INSERT INTO discussion_threads (id, kind, forum_id, root_id, created_at)
      SELECT ?, ?, ?, ?, ? WHERE ${guard.sql}`)
      .bind(threadId, announcement ? 'announcement' : 'question', category.id, id, time, ...guard.values),
    c.env.DB.prepare(`INSERT INTO discussion_nodes (id, thread_id, parent_id, depth, created_at)
      SELECT ?, t.id, NULL, 0, ? FROM discussion_threads t WHERE t.id = ? AND t.root_id = ?`)
      .bind(id, time, threadId, id),
    c.env.DB.prepare(`INSERT INTO comments (id, page_id, author_id, body, title, status, created_at, reviewed_at, reviewed_by)
      SELECT n.id, '', ?, ?, ?, ?, n.created_at, ?, ? FROM discussion_nodes n WHERE n.id = ? RETURNING id`)
      .bind(session.user_id, input.body, input.title, announcement ? 'published' : 'pending',
        announcement ? time : null, announcement ? session.user_id : null, id),
    c.env.DB.prepare(`INSERT INTO moderation_audit (id, moderator_id, comment_id, action, created_at)
      SELECT ?, ?, c.id, 'publish', ? FROM comments c WHERE c.id = ? AND c.status = 'published' AND c.reviewed_by = ?`)
      .bind(crypto.randomUUID(), session.user_id, time, id, session.user_id),
  ]);
  if (results[2]?.results[0]?.id !== id) {
    throw new HTTPException(409, { message: 'Your account or announcement permission changed before saving. Sign in and retry.' });
  }
  const root = await visibleComment(c, id);
  return c.json(commentPage(c, threadFromRow(root), [root]), 201);
});

discussions.get('/comments/:id/replies', async (c) => {
  const session = requireSession(c, { currentConsent: true });
  const id = c.req.param('id');
  const [after, afterId] = cursorValues(c.req.query('cursor'), true);
  const results = await c.env.DB.batch<CommentRow>([
    visibleCommentStatement(c, id),
    c.env.DB.prepare(`${ancestorsSql} SELECT ${commentColumns} ${commentJoins}
      WHERE n.parent_id = ? AND ${readable('n', 'c')}
      AND EXISTS (SELECT 1 FROM discussion_nodes p WHERE p.id = n.parent_id AND ${visiblePath('p')})
      AND (n.created_at > ? OR (n.created_at = ? AND n.id > ?))
      ORDER BY n.created_at ASC, n.id ASC LIMIT ${DISCUSSION_PAGE_SIZE + 1}`)
      .bind(session.user_id, id, id, after, after, afterId),
  ]);
  const parent = results[0]?.results[0];
  if (!parent) throw new HTTPException(404, { message: 'Contribution not found.' });
  return c.json(commentPage(c, threadFromRow(parent), results[1]?.results || []));
});

discussions.post('/comments/:id/replies', async (c) => {
  requireCommunityEnabled(c);
  const session = requireSession(c, { currentConsent: true });
  const parentId = c.req.param('id');
  const input = await readJson(c, commentSchema);
  const parent = await visibleComment(c, parentId);
  if (parent.depth >= DISCUSSION_MAX_DEPTH) {
    throw new HTTPException(400, { message: `Replies are limited to depth ${DISCUSSION_MAX_DEPTH}. Start a new question; this reply has not been saved.` });
  }
  if (parent.hidden_ancestors) throw new HTTPException(400, { message: 'Hidden branches cannot receive replies.' });
  await contributionRateLimits(c, session);
  const time = now();
  const guard = liveGuard(session, time);
  const id = crypto.randomUUID();
  const results = await c.env.DB.batch<{ id: string }>([
    c.env.DB.prepare(`${ancestorsSql} INSERT INTO discussion_nodes (id, thread_id, parent_id, depth, created_at)
      SELECT ?, n.thread_id, n.id, n.depth + 1, ? FROM discussion_nodes n
      WHERE n.id = ? AND n.depth < ${DISCUSSION_MAX_DEPTH} AND ${visiblePath('n')}
      AND NOT EXISTS (SELECT 1 FROM ancestry WHERE status = 'hidden') AND ${guard.sql}`)
      .bind(session.user_id, parentId, id, time, parentId, ...guard.values),
    c.env.DB.prepare(`INSERT INTO comments (id, page_id, author_id, body, status, created_at)
      SELECT n.id, COALESCE(t.page_id, ''), ?, ?, 'pending', n.created_at
      FROM discussion_nodes n JOIN discussion_threads t ON t.id = n.thread_id WHERE n.id = ? RETURNING id`)
      .bind(session.user_id, input.body, id),
  ]);
  if (results[1]?.results[0]?.id !== id) {
    throw new HTTPException(409, { message: 'The parent discussion or account changed before saving. Refresh; the reply was not saved.' });
  }
  return c.json(await insertedComment(c, id), 201);
});

discussions.delete('/comments/:id', async (c) => {
  const session = requireSession(c);
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare("SELECT id FROM comments WHERE id = ? AND author_id = ? AND status != 'removed'")
    .bind(id, session.user_id).first<{ id: string }>();
  if (!existing) throw new HTTPException(404, { message: 'Contribution not found or not owned by you.' });
  const guard = liveGuard(session, now(), { consent: false });
  const results = await c.env.DB.batch<{ id: string }>([
    c.env.DB.prepare(`UPDATE comments SET status = 'removed', body = '', title = NULL
      WHERE id = ? AND author_id = ? AND status != 'removed' AND ${guard.sql} RETURNING id`)
      .bind(id, session.user_id, ...guard.values),
    c.env.DB.prepare(`DELETE FROM reports WHERE comment_id = ? AND EXISTS (
      SELECT 1 FROM comments WHERE id = ? AND author_id = ? AND status = 'removed' AND ${guard.sql})`)
      .bind(id, id, session.user_id, ...guard.values),
    pruneEmptyDiscussionBranches(c.env.DB,
      `SELECT n.thread_id FROM discussion_nodes n JOIN comments c ON c.id = n.id
       WHERE n.id = ? AND c.author_id = ? AND c.status = 'removed' AND ${guard.sql}`, [id, session.user_id, ...guard.values]),
  ]);
  if (results[0]?.results[0]?.id !== id) throw new HTTPException(404, { message: 'Contribution not found or not owned by you.' });
  return c.json({ removed: true });
});

discussions.post('/comments/:id/report', async (c) => {
  const session = requireSession(c, { currentConsent: true });
  await rateLimit(c, 'reports', 10, 3600, session.user_id);
  const input = await readJson(c, z.object({
    reason: z.string().trim().min(10).max(300)
      .refine((reason) => !hasDisallowedControl(reason), 'Control characters are not allowed.')
      .refine((reason) => !containsLikelySecret(reason), 'Potential secret detected. Redact the report.'),
  }).strict());
  const id = c.req.param('id');
  const comment = await visibleComment(c, id);
  if (comment.status !== 'published') throw new HTTPException(404, { message: 'Published contribution not found.' });
  const time = now();
  const guard = liveGuard(session, time);
  const result = await c.env.DB.prepare(`${ancestorsSql}
    INSERT INTO reports (comment_id, reporter_id, reason, created_at)
    SELECT n.id, ?, ?, ? FROM discussion_nodes n JOIN comments c ON c.id = n.id
    WHERE n.id = ? AND c.status = 'published' AND ${visiblePath('n')} AND ${guard.sql}
    ON CONFLICT(comment_id, reporter_id) DO UPDATE SET reason = excluded.reason RETURNING comment_id`)
    .bind(session.user_id, id, session.user_id, input.reason, time, id, ...guard.values).first<{ comment_id: string }>();
  if (result?.comment_id !== id) throw new HTTPException(409, { message: 'The contribution or account changed before reporting. Refresh the discussion.' });
  return c.json({ reported: true });
});

export const contributionReview = new Hono<AppEnv>();

contributionReview.get('/', async (c) => {
  const session = await requireReviewAccess(c);
  const status = c.req.query('status') || 'queue';
  const filters: Record<string, string> = {
    queue: "(c.status = 'pending' OR (c.status = 'published' AND EXISTS (SELECT 1 FROM reports r WHERE r.comment_id = c.id)))",
    pending: "c.status = 'pending'", published: "c.status = 'published'", hidden: "c.status = 'hidden'",
    reported: "c.status = 'published' AND EXISTS (SELECT 1 FROM reports r WHERE r.comment_id = c.id)",
  };
  const filter = filters[status];
  if (!filter) throw new HTTPException(400, { message: 'Choose a supported contribution status.' });
  const rows = await c.env.DB.prepare(`WITH viewer(user_id) AS (VALUES (?))
    SELECT ${commentColumns},
      (SELECT COUNT(*) FROM reports r WHERE r.comment_id = c.id) AS reports,
      (SELECT json_group_array(reason) FROM (
        SELECT reason FROM reports WHERE comment_id = c.id ORDER BY created_at DESC LIMIT 10)) AS report_reasons,
      (SELECT json_group_array(json_object(
        'id', parent.id, 'parentId', parent.parent_id, 'depth', parent.depth,
        'handle', CASE WHEN content.status IS NULL OR content.status = 'removed' THEN 'Removed contribution' ELSE COALESCE(author.handle, 'Deleted member') END,
        'body', CASE WHEN content.status IS NULL OR content.status = 'removed' THEN '' ELSE content.body END,
        'status', COALESCE(content.status, 'removed'))) FROM (
          WITH RECURSIVE parents AS (
            SELECT p.* FROM discussion_nodes p WHERE p.id = n.parent_id
            UNION ALL SELECT p.* FROM discussion_nodes p JOIN parents previous ON p.id = previous.parent_id
              AND p.thread_id = previous.thread_id AND p.depth = previous.depth - 1 WHERE previous.depth > 0
          ) SELECT * FROM parents ORDER BY depth
        ) parent LEFT JOIN comments content ON content.id = parent.id LEFT JOIN users author ON author.id = content.author_id) AS ancestors
    ${commentJoins}
    WHERE ${filter}
    ORDER BY n.created_at ASC, n.id ASC LIMIT 100`)
    .bind(session.user_id).all<CommentRow>();
  return c.json(rows.results.map((row) => toComment(c, row)));
});

contributionReview.post('/:id', async (c) => {
  const session = await requireReviewAccess(c);
  await rateLimit(c, 'moderation', 200, 3600, session.user_id);
  const input = await readJson(c, z.object({ action: z.enum(['publish', 'hide']) }).strict());
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT id FROM comments WHERE id = ? AND status != ?').bind(id, 'removed').first();
  if (!existing) throw new HTTPException(404, { message: 'Contribution not found.' });
  const time = now();
  const status = input.action === 'publish' ? 'published' : 'hidden';
  const guard = liveGuard(session, time, { fresh: true, privilege: 'review', ownerHash: await pinnedOwnerHash() });
  const results = await c.env.DB.batch<{ id: string }>([
    c.env.DB.prepare(`UPDATE comments SET status = ?, reviewed_at = ?, reviewed_by = ?
      WHERE id = ? AND status != 'removed' AND ${guard.sql} RETURNING id`)
      .bind(status, time, session.user_id, id, ...guard.values),
    c.env.DB.prepare(`DELETE FROM reports WHERE comment_id = ? AND EXISTS (
      SELECT 1 FROM comments WHERE id = ? AND status = ? AND reviewed_at = ? AND reviewed_by = ? AND ${guard.sql})`)
      .bind(id, id, status, time, session.user_id, ...guard.values),
    c.env.DB.prepare(`INSERT INTO moderation_audit (id, moderator_id, comment_id, action, created_at)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM comments WHERE id = ? AND status = ? AND reviewed_at = ? AND reviewed_by = ? AND ${guard.sql})`)
      .bind(crypto.randomUUID(), session.user_id, id, input.action, time, id, status, time, session.user_id, ...guard.values),
  ]);
  if (results[0]?.results[0]?.id !== id) throw new HTTPException(409, { message: 'The contribution or review access changed. Refresh the queue.' });
  return c.json({ reviewed: true });
});

discussions.route('/moderation', contributionReview);
