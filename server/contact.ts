import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { now, rateLimit, requireSession, verifyTurnstile } from './security';
import { containsLikelySecret, hasDisallowedControl, readJson } from './validation';
import type { AppEnv } from './types';
import { requireReviewAccess } from './management-access';

export const contactRequestSchema = z.object({
  message: z.string().trim().min(10).max(2000)
    .refine((value) => !hasDisallowedControl(value), 'Control characters are not allowed.')
    .refine((value) => !containsLikelySecret(value), 'Remove credentials and live tokens before sending.'),
  replyEmail: z.union([z.email().max(254), z.literal('')]).optional(),
  turnstileToken: z.string().max(2048).optional(),
}).strict();

export const contact = new Hono<AppEnv>();

contact.post('/contact', async (c) => {
  const session = c.get('session');
  if (session) requireSession(c);
  await rateLimit(c, 'private-contact-network', 10, 3600);
  if (session) await rateLimit(c, 'private-contact-account', 10, 3600, session.user_id);
  const input = await readJson(c, contactRequestSchema);
  await verifyTurnstile(c, input.turnstileToken, 'contact');
  const id = crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO contact_requests (id, user_id, reply_email, message, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, session?.user_id || null, input.replyEmail || null, input.message, now()).run();
  return c.json({ received: true, reference: id }, 201);
});

export const privateContactReview = new Hono<AppEnv>();

privateContactReview.get('/', async (c) => {
  await requireReviewAccess(c);
  const requests = await c.env.DB.prepare(
    'SELECT id, reply_email AS replyEmail, message, status, created_at AS createdAt FROM contact_requests WHERE status = ? ORDER BY created_at LIMIT 50',
  ).bind('new').all();
  return c.json(requests.results);
});

privateContactReview.post('/:id/resolve', async (c) => {
  const session = await requireReviewAccess(c);
  await readJson(c, z.object({}).strict());
  const result = await c.env.DB.prepare(
    'UPDATE contact_requests SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ? AND status = ? RETURNING id',
  ).bind('resolved', now(), session.user_id, c.req.param('id'), 'new').first();
  if (!result) throw new HTTPException(404, { message: 'Unresolved request not found.' });
  return c.json({ resolved: true });
});

contact.route('/moderation/contacts', privateContactReview);
