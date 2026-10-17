import { Hono } from 'hono';
import { z } from 'zod';
import { lessons, sources, tracks } from '../shared/catalog';
import { contributionReview } from './discussions';
import { privateContactReview } from './contact';
import { requireSiteManagement } from './management-access';
import { lessonContent } from './lesson-content';
import { now } from './security';
import { readSourceStatuses } from './source-monitor';
import type { AppEnv } from './types';

export const management = new Hono<AppEnv>();

management.use('/*', async (c, next) => {
  await requireSiteManagement(c);
  await next();
});

management.get('/overview', async (c) => {
  const counts = await c.env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM users) AS accounts,
      (SELECT COUNT(*) FROM sessions WHERE expires_at > ?) AS activeSessions,
      (SELECT COUNT(*) FROM comments WHERE status = 'pending') AS pendingContributions,
      (SELECT COUNT(*) FROM contact_requests WHERE status = 'new') AS unresolvedRequests`,
  ).bind(now()).first();
  const parsed = z.object({
    accounts: z.number(), activeSessions: z.number(), pendingContributions: z.number(),
    unresolvedRequests: z.number(),
  }).parse(counts);
  const statuses = await readSourceStatuses(c.env.DB);
  return c.json({
    ...parsed, publishedCourses: tracks.filter((track) => track.status === 'available').length,
    publishedTopics: lessons.length,
    sourceAlerts: statuses.filter((entry) => entry.status !== 'unchanged' || entry.checkedAt === null || entry.checkedAt < now() - 48 * 3600).length,
  });
});

management.get('/accounts', async (c) => {
  const accounts = await c.env.DB.prepare(
    `SELECT u.id, u.handle, u.role, u.created_at AS createdAt,
      (SELECT MAX(authenticated_at) FROM sessions WHERE user_id = u.id) AS lastSignIn,
      (SELECT COUNT(*) FROM passkeys WHERE user_id = u.id) AS passkeys,
      (SELECT COUNT(*) FROM social_identities WHERE user_id = u.id) AS linkedProviders
      FROM users u ORDER BY u.created_at DESC, u.id LIMIT 100`,
  ).all();
  return c.json(accounts.results);
});

management.get('/audit', async (c) => {
  const records = await c.env.DB.prepare(
    `SELECT a.id, u.handle, a.action, a.comment_id AS recordId, a.created_at AS createdAt
      FROM moderation_audit a LEFT JOIN users u ON u.id = a.moderator_id
      ORDER BY a.created_at DESC, a.id LIMIT 100`,
  ).all();
  return c.json(records.results);
});

management.get('/references', async (c) => {
  const records = await readSourceStatuses(c.env.DB);
  return c.json(sources.map((source) => {
    const row = records.find((entry) => entry.sourceId === source.id);
    if (!row) throw new Error('Registered source status is missing.');
    return { ...row, title: source.title, url: source.url };
  }));
});

management.get('/content-history', async (c) => {
  const records = await c.env.DB.prepare(`SELECT h.id, h.lesson_id AS lessonId, h.revision,
    h.reason, h.created_at AS createdAt, u.handle AS editor
    FROM lesson_content_history h LEFT JOIN users u ON u.id = h.editor_id
    ORDER BY h.created_at DESC, h.id DESC LIMIT 100`).all();
  return c.json(records.results);
});

management.route('/contributions', contributionReview);
management.route('/requests', privateContactReview);
management.route('/content', lessonContent);
