import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { account } from './account';
import { contact } from './contact';
import { auth } from './auth';
import { discussions } from './discussions';
import { learning } from './learning';
import { socialAuth } from './social-auth';
import { management } from './management';
import { readLessons } from './lesson-content';
import { requireSiteManagement } from './management-access';
import { pageIds, sources, tracks } from '../shared/catalog';
import { isPublicApiRequest, MEMBER_ASSET_ROUTES } from '../shared/access-policy';
import { PRIVACY_VERSION, TERMS_VERSION } from '../shared/contracts';
import { checkSources, cleanupExpiredData, sourceRoutes } from './source-monitor';
import { CSP, enforceRequestOrigin, getPublicSiteConfig, loadSession, requireSession } from './security';
import type { AppEnv, Env } from './types';

const app = new Hono<AppEnv>();

app.use('/api/*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  c.header('X-Request-ID', c.get('requestId'));
  c.header('Cache-Control', 'no-store');
  c.header('Content-Security-Policy', CSP);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  c.header('Strict-Transport-Security', 'max-age=31536000');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) enforceRequestOrigin(c);
  c.set('session', await loadSession(c));
  if (!isPublicApiRequest(c.req.method, c.req.path)) requireSession(c);
  await next();
});

app.use('/api/*', bodyLimit({
  maxSize: 32768,
  onError: (c) => c.json({ error: 'Request body exceeds 32 KiB.', requestId: c.get('requestId') }, 413),
}));

app.get('/api/health', async (c) => {
  const tables = await c.env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'passkeys', 'sessions', 'consents', 'progress', 'comments', 'discussion_threads', 'discussion_nodes', 'source_checks', 'contact_requests', 'social_identities', 'oauth_flows', 'lesson_content', 'lesson_content_history')",
  ).all<{ name: string }>();
  if (tables.results.length !== 14) throw new HTTPException(503, { message: 'Database migrations are incomplete.' });
  return c.json({ ok: true, service: 'Security Resource Kit', version: '0.1.0' });
});

app.get('/api/config', (c) => c.json(getPublicSiteConfig(c.env)));
app.get('/api/outline', (c) => c.json(tracks.map(({ id, title, status }) => ({ id, title, status }))));
app.get('/api/catalog', async (c) => {
  requireSession(c, { currentConsent: true });
  return c.json({ lessons: await readLessons(c.env.DB), tracks, sources, pageIds: [...pageIds] });
});
app.route('/api/auth', auth);
app.route('/api/auth/social', socialAuth);
app.route('/api/account', account);
app.route('/api', learning);
app.route('/api', discussions);
app.route('/api', sourceRoutes);
app.route('/api', contact);
app.route('/api/management', management);

for (const path of MEMBER_ASSET_ROUTES) {
  app.get(path, async (c) => {
    c.header('Cache-Control', 'no-store');
    const session = await loadSession(c);
    if (!session) return c.redirect('/', 303);
    if (c.req.path === '/management' || c.req.path.startsWith('/management/')) {
      c.set('session', session);
      await requireSiteManagement(c, false);
    }
    if (c.req.path !== '/account' &&
      (session.terms_version !== TERMS_VERSION || session.privacy_version !== PRIVACY_VERSION)) {
      return c.redirect('/account', 303);
    }
    const response = await c.env.ASSETS.fetch(c.req.raw);
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');
    return new Response(response.body, { status: response.status, headers });
  });
}

app.notFound((c) => c.json({ error: 'Endpoint not found.', requestId: c.get('requestId') }, 404));

app.onError((error, c) => {
  if (error instanceof HTTPException) {
    return c.json({ error: error.message, requestId: c.get('requestId') }, error.status);
  }
  console.error(JSON.stringify({ event: 'request_failed', requestId: c.get('requestId'), error: error.name }));
  return c.json({ error: 'The service could not complete this request. Retry shortly.', requestId: c.get('requestId') }, 503);
});

export { app };

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await cleanupExpiredData(env);
    await checkSources(env);
  },
} satisfies ExportedHandler<Env>;
