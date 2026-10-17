import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { PRIVACY_VERSION, TERMS_VERSION } from '../shared/contracts';
import type { SiteConfig } from '../shared/contracts';
import { configuredSocialProviders } from './social-providers';
import type { AppContext, SessionRow, SiteEnv } from './types';

export const CSP = "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
export const SESSION_SECONDS = 8 * 60 * 60;
export const CHALLENGE_SECONDS = 10 * 60;
export const FRESH_AUTH_SECONDS = 5 * 60;
const tokenPattern = /^[a-f0-9]{64}$/u;

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function encodeBytes(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

export function decodeBytes(encoded: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(encoded.replace(/-/gu, '+').replace(/_/gu, '/')), (char) => char.charCodeAt(0));
}

export function isLocal(env: SiteEnv): boolean {
  return env.ENVIRONMENT === 'local' && env.APP_ORIGIN === 'http://localhost:8787' && env.RP_ID === 'localhost';
}

type AuthCookiePurpose = 'session' | 'flow' | 'oauth';

export function cookieName(env: SiteEnv, purpose: AuthCookiePurpose): string {
  return `${isLocal(env) ? '' : '__Host-'}srk-${purpose}`;
}

export function setAuthCookie(c: AppContext, purpose: AuthCookiePurpose, value: string, seconds: number): void {
  setCookie(c, cookieName(c.env, purpose), value, {
    path: '/',
    httpOnly: true,
    secure: !isLocal(c.env),
    sameSite: purpose === 'oauth' ? 'Lax' : 'Strict',
    maxAge: seconds,
  });
}

export function clearAuthCookie(c: AppContext, purpose: AuthCookiePurpose): void {
  deleteCookie(c, cookieName(c.env, purpose), {
    path: '/', httpOnly: true, secure: !isLocal(c.env), sameSite: purpose === 'oauth' ? 'Lax' : 'Strict',
  });
}

export function getAuthCookie(c: AppContext, purpose: AuthCookiePurpose): string | undefined {
  const value = getCookie(c, cookieName(c.env, purpose));
  return value && tokenPattern.test(value) ? value : undefined;
}

export function sameToken(left: string, right: string): boolean {
  if (!tokenPattern.test(left) || !tokenPattern.test(right)) return false;
  let difference = 0;
  for (let index = 0; index < 64; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export function getSiteConfig(env: SiteEnv): SiteConfig & { setupRequired: string[] } {
  const setupRequired: string[] = [];
  if (!isLocal(env)) {
    const origin = URL.canParse(env.APP_ORIGIN) ? new URL(env.APP_ORIGIN) : null;
    if (!origin || origin.protocol !== 'https:' || origin.origin !== env.APP_ORIGIN || origin.hostname.endsWith('.invalid') || origin.hostname !== env.RP_ID) {
      setupRequired.push('Configure the HTTPS site origin and matching passkey RP ID.');
    }
    if (env.LEGAL_APPROVED !== 'true') setupRequired.push('The operator must review and approve the terms and privacy policy.');
    if (!env.OPERATOR_NAME.trim() || !isHttpsUrl(env.CONTACT_URL)) setupRequired.push('Configure the responsible operator and an HTTPS contact channel.');
    if (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY) setupRequired.push('Configure production Turnstile anti-abuse keys.');
    if (!env.RATE_LIMIT_SALT || env.RATE_LIMIT_SALT.length < 32 || env.RATE_LIMIT_SALT.startsWith('local-')) setupRequired.push('Configure a private rate-limit salt.');
  }
  return {
    environment: isLocal(env) ? 'local' : 'production',
    registrationEnabled: setupRequired.length === 0,
    setupRequired,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY,
    operatorName: env.OPERATOR_NAME || '@oguzhanf',
    contactUrl: isHttpsUrl(env.CONTACT_URL) ? env.CONTACT_URL : '',
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION,
    authProviders: setupRequired.length === 0 ? configuredSocialProviders(env) : [],
  };
}

export function getPublicSiteConfig(env: SiteEnv): SiteConfig {
  const config = getSiteConfig(env);
  return {
    environment: config.environment,
    registrationEnabled: config.registrationEnabled,
    turnstileSiteKey: config.turnstileSiteKey,
    operatorName: config.operatorName,
    contactUrl: config.contactUrl,
    termsVersion: config.termsVersion,
    privacyVersion: config.privacyVersion,
    authProviders: config.authProviders,
  };
}

function isHttpsUrl(value: string): boolean {
  return URL.canParse(value) && new URL(value).protocol === 'https:' && !new URL(value).username && !new URL(value).password;
}

export function requireCommunityEnabled(c: AppContext): void {
  if (!getSiteConfig(c.env).registrationEnabled) {
    throw new HTTPException(503, { message: 'Registration is currently unavailable.' });
  }
}

export function enforceRequestOrigin(c: AppContext): void {
  if (new URL(c.req.url).origin !== c.env.APP_ORIGIN || c.req.header('Origin') !== c.env.APP_ORIGIN) {
    throw new HTTPException(403, { message: 'Request origin is not allowed.' });
  }
  const fetchSite = c.req.header('Sec-Fetch-Site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new HTTPException(403, { message: 'Cross-site requests are not allowed.' });
  }
  if (c.req.header('X-SRK-Request') !== '1') {
    throw new HTTPException(403, { message: 'Required request header is missing.' });
  }
  if (!/^application\/json(?:\s*;|$)/iu.test(c.req.header('Content-Type') || '')) {
    throw new HTTPException(415, { message: 'Requests must use application/json.' });
  }
}

export async function loadSession(c: AppContext): Promise<SessionRow | null> {
  const token = getAuthCookie(c, 'session');
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await readSession(c, tokenHash);
  if (!row) clearAuthCookie(c, 'session');
  return row;
}

export async function readSession(c: AppContext, tokenHash: string): Promise<SessionRow | null> {
  return c.env.DB.prepare(
    'SELECT s.*, u.handle, u.role, u.terms_version, u.privacy_version FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?',
  ).bind(tokenHash, now()).first<SessionRow>();
}

export function requireSession(c: AppContext, options: { fresh?: boolean; currentConsent?: boolean } = {}): SessionRow {
  const session = c.get('session');
  if (!session) throw new HTTPException(401, { message: 'Sign in first.' });
  if (options.fresh && now() - session.authenticated_at > FRESH_AUTH_SECONDS) {
    throw new HTTPException(403, { message: 'Sign in again. This action requires authentication within five minutes.' });
  }
  if (options.currentConsent && (session.terms_version !== TERMS_VERSION || session.privacy_version !== PRIVACY_VERSION)) {
    throw new HTTPException(428, { message: 'Review and accept the current terms and privacy policy in My account before participating.' });
  }
  if (c.req.method !== 'GET' && !sameToken(c.req.header('X-CSRF-Token') || '', session.csrf_token)) {
    throw new HTTPException(403, { message: 'Security token is missing or invalid. Refresh the page and retry.' });
  }
  return session;
}

export async function issueSession(c: AppContext, userId: string): Promise<void> {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const oldSession = c.get('session');
  const time = now();
  const statements = [
    c.env.DB.prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, authenticated_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(tokenHash, userId, randomToken(), time, time + SESSION_SECONDS),
  ];
  if (oldSession) statements.push(c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(oldSession.token_hash));
  statements.push(c.env.DB.prepare(
    'DELETE FROM sessions WHERE user_id = ? AND token_hash != ? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id = ? AND token_hash != ? AND expires_at > ? ORDER BY authenticated_at DESC, token_hash LIMIT 4)',
  ).bind(userId, tokenHash, userId, tokenHash, time));
  await c.env.DB.batch(statements);
  await cancelAuthFlows(c);
  setAuthCookie(c, 'session', token, SESSION_SECONDS);
}

export async function cancelAuthFlows(c: AppContext): Promise<void> {
  const passkey = getAuthCookie(c, 'flow');
  const oauth = getAuthCookie(c, 'oauth');
  const statements: D1PreparedStatement[] = [];
  if (passkey) statements.push(c.env.DB.prepare('DELETE FROM auth_challenges WHERE id_hash = ?').bind(await sha256(passkey)));
  if (oauth) statements.push(c.env.DB.prepare('DELETE FROM oauth_flows WHERE browser_hash = ?').bind(await sha256(oauth)));
  if (statements.length) await c.env.DB.batch(statements);
  clearAuthCookie(c, 'flow');
  clearAuthCookie(c, 'oauth');
}

export async function rateLimit(c: AppContext, scope: string, max: number, windowSeconds: number, accountId?: string): Promise<void> {
  if (!c.env.RATE_LIMIT_SALT) throw new HTTPException(503, { message: 'The service is temporarily unavailable. Try again later.' });
  const subject = accountId || (isLocal(c.env) ? 'local-test-client' : c.req.header('CF-Connecting-IP'));
  if (!subject) throw new HTTPException(503, { message: 'The service is temporarily unavailable. Try again later.' });
  const time = now();
  const window = Math.floor(time / windowSeconds);
  const key = await sha256(`${c.env.RATE_LIMIT_SALT}:${scope}:${subject}:${window}`);
  const expires = (window + 1) * windowSeconds;
  const result = await c.env.DB.prepare(
    'INSERT INTO rate_limits (bucket_key, hits, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket_key) DO UPDATE SET hits = hits + 1 RETURNING hits',
  ).bind(key, expires).first<{ hits: number }>();
  if (!result) throw new HTTPException(503, { message: 'Anti-abuse service is unavailable.' });
  if (result.hits > max) {
    c.header('Retry-After', String(expires - time));
    throw new HTTPException(429, { message: 'Too many requests. Wait before trying again.' });
  }
}

const turnstileResultSchema = z.object({
  success: z.boolean(),
  hostname: z.string().optional(),
  action: z.string().optional(),
});

export async function verifyTurnstile(c: AppContext, token: string | undefined, action: 'register' | 'comment' | 'contact'): Promise<void> {
  if (isLocal(c.env)) return;
  if (!c.env.TURNSTILE_SECRET_KEY || !token) throw new HTTPException(400, { message: 'Complete the anti-abuse check before continuing.' });
  let response: Response;
  try {
    response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      redirect: 'manual',
      body: new URLSearchParams({
        secret: c.env.TURNSTILE_SECRET_KEY,
        response: token,
        idempotency_key: crypto.randomUUID(),
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    console.warn(JSON.stringify({ event: 'turnstile_unavailable', error: error instanceof Error ? error.name : 'unknown' }));
    throw new HTTPException(503, { message: 'The anti-abuse service is temporarily unavailable. Retry shortly.' });
  }
  if (!response.ok) throw new HTTPException(503, { message: 'The anti-abuse service is temporarily unavailable.' });
  const result = turnstileResultSchema.safeParse(await response.json());
  if (!result.success) throw new HTTPException(503, { message: 'The anti-abuse service returned an invalid response.' });
  if (!result.data.success || result.data.action !== action || result.data.hostname !== new URL(c.env.APP_ORIGIN).hostname) {
    throw new HTTPException(400, { message: 'The anti-abuse check failed or expired. Complete it again.' });
  }
}
