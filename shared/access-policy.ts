export const PUBLIC_PAGE_IDS = new Set(['home', 'terms', 'privacy', 'contact']);

export const MEMBER_ASSET_ROUTES = [
  '/learn/*', '/tracks/*', '/about', '/sources', '/roadmap', '/account',
  '/management', '/management/*', '/discussions', '/discussions/*', '/training-media/*',
];

export const WORKER_FIRST_ROUTES = ['/api/*', ...MEMBER_ASSET_ROUTES];

const PUBLIC_API_REQUESTS = new Set([
  'GET /api/health',
  'GET /api/config',
  'GET /api/outline',
  'GET /api/auth/me',
  'POST /api/auth/register/options',
  'POST /api/auth/register/verify',
  'POST /api/auth/login/options',
  'POST /api/auth/login/verify',
  'POST /api/auth/social/microsoft/start',
  'POST /api/auth/social/github/start',
  'GET /api/auth/social/microsoft/callback',
  'GET /api/auth/social/github/callback',
  'POST /api/contact',
]);

export function isPublicApiRequest(method: string, pathname: string): boolean {
  return PUBLIC_API_REQUESTS.has(`${method} ${pathname}`);
}
