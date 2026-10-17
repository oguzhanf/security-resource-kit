import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { z } from 'zod';
import { app } from '../server/index';
import { now, randomToken, sha256 } from '../server/security';
import type { Env } from '../server/types';
import { configSchema, sessionSchema, socialAuthorizationSchema } from '../shared/api-schemas';
import { PRIVACY_VERSION, TERMS_VERSION } from '../shared/contracts';
import type { SocialAuthInput, SocialProviderId } from '../shared/contracts';
import { SqliteD1 } from './fixtures/sqlite-d1';
import { MANAGEMENT_GITHUB_USER_ID } from '../server/management-access';
import { managementOverviewSchema, managementAccountsSchema, managementAuditSchema, managementReferencesSchema } from '../shared/management-schemas';
import { lessons } from '../shared/catalog';

const origin = 'https://security.example.test';
const clientId = '11111111-2222-4333-8444-555555555555';
const tenantId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const otherTenant = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const githubToken = 'test-only-provider-token-not-a-real-credential';
const stateCookie = '__Host-srk-oauth';
const sessionCookie = '__Host-srk-session';
let db: SqliteD1;
let env: Env;
let signingKey: CryptoKey;
let keys: { keys: object[] };
let githubId: number;
let githubScope: string;
let providerFailure: 'none' | 'redirect' | 'malformed' | 'missing-id';
let msNonce: string;
let msSubject: string;
let msAudience: string;
let msIssuer: string;
let msKid: string;
let msExpired: boolean;
let msMissingExpiry: boolean;
let msWrongSignature: boolean;
const networkRequests: { url: string; options: RequestInit }[] = [];

beforeAll(async () => {
  const generated = await generateKeyPair('RS256');
  signingKey = generated.privateKey;
  const publicKey = await exportJWK(generated.publicKey);
  keys = { keys: [
    { ...publicKey, kid: 'test-key', use: 'sig', alg: 'RS256', issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0' },
    { ...publicKey, kid: 'tenant-specific-key', use: 'sig', alg: 'RS256', issuer: `https://login.microsoftonline.com/${otherTenant}/v2.0` },
  ] };
});

beforeEach(() => {
  db = new SqliteD1();
  env = {
    DB: db,
    ASSETS: { async fetch() { return new Response('Test assets'); }, connect() { throw new Error('Socket bindings are not used in these tests.'); } },
    ENVIRONMENT: 'production', APP_ORIGIN: origin, RP_ID: 'security.example.test', LEGAL_APPROVED: 'true',
    OPERATOR_NAME: 'Test operator', CONTACT_URL: `${origin}/contact`,
    TURNSTILE_SITE_KEY: 'test-only-widget', TURNSTILE_SECRET_KEY: 'test-only-widget-secret',
    RATE_LIMIT_SALT: 'test-only-private-rate-salt-not-for-production',
    GITHUB_CLIENT_ID: 'test-only-github-client', GITHUB_CLIENT_SECRET: 'test-only-github-secret',
    MICROSOFT_CLIENT_ID: clientId, MICROSOFT_CLIENT_SECRET: 'test-only-microsoft-secret',
  };
  githubId = 123456789;
  githubScope = '';
  providerFailure = 'none';
  msNonce = '';
  msSubject = 'test-subject';
  msAudience = clientId;
  msIssuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  msKid = 'test-key';
  msExpired = false;
  msMissingExpiry = false;
  msWrongSignature = false;
  networkRequests.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options: RequestInit = {}) => {
    const url = String(input);
    networkRequests.push({ url, options });
    if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      return Response.json({ success: true, action: 'register', hostname: 'security.example.test' });
    }
    if (url === 'https://github.com/login/oauth/access_token') {
      if (providerFailure === 'malformed') return Response.json({ error: 'bad_verification_code' });
      return Response.json({ access_token: githubToken, token_type: 'bearer', scope: githubScope });
    }
    if (url === 'https://api.github.com/user') {
      if (providerFailure === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://attacker.example/profile' } });
      if (providerFailure === 'missing-id') return Response.json({ login: 'same-name', type: 'User', email: 'shared@example.test' });
      return Response.json({ id: githubId, type: 'User', login: 'same-name', email: 'shared@example.test', role: 'moderator' });
    }
    if (url === 'https://login.microsoftonline.com/common/discovery/v2.0/keys') return Response.json(keys);
    if (url === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') {
      let token = new SignJWT({ tid: tenantId, ver: '2.0', nonce: msNonce, email: 'shared@example.test', roles: ['moderator'] })
        .setProtectedHeader({ alg: 'RS256', kid: msKid }).setSubject(msSubject)
        .setIssuer(msIssuer).setAudience(msAudience).setIssuedAt().setNotBefore(now() - 1);
      if (!msMissingExpiry) token = token.setExpirationTime(msExpired ? now() - 10 : now() + 3600);
      const key = msWrongSignature ? (await generateKeyPair('RS256')).privateKey : signingKey;
      return Response.json({ id_token: await token.sign(key), token_type: 'Bearer' });
    }
    throw new Error(`Unexpected outbound URL: ${url}`);
  }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});

async function api(path: string, options: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; cookie?: string; csrf?: string; headers?: Record<string, string> } = {}) {
  const method = options.method || 'GET';
  return app.request(`${origin}${path}`, {
    method,
    headers: {
      'CF-Connecting-IP': '198.51.100.10',
      ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json', 'X-SRK-Request': '1' }),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.csrf ? { 'X-CSRF-Token': options.csrf } : {}),
      ...options.headers,
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(options.body || {}) }),
  }, env);
}

function cookie(response: Response, name: string): string {
  const value = response.headers.getSetCookie().find((entry) => entry.startsWith(`${name}=`) && !entry.includes('Max-Age=0'));
  if (!value) throw new Error(`Missing ${name} cookie.`);
  return value.split(';')[0] || '';
}

const registration = (handle: string): SocialAuthInput => ({
  intent: 'register', handle, accepted: true, termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION,
  turnstileToken: 'test-only-widget-proof',
});

async function start(body: SocialAuthInput, provider: SocialProviderId = 'github', credentials?: { cookie: string; csrf: string }) {
  const response = await api(`/api/auth/social/${provider}/start`, {
    method: 'POST', body, cookie: credentials?.cookie, csrf: credentials?.csrf,
  });
  expect(response.status).toBe(200);
  const result = socialAuthorizationSchema.parse(await response.json());
  const url = new URL(result.authorizationUrl);
  if (provider === 'microsoft') msNonce = url.searchParams.get('nonce') || '';
  return { response, url, cookie: cookie(response, stateCookie), provider };
}

async function finish(flow: Awaited<ReturnType<typeof start>>, code = 'test-only-code', extraCookie = '') {
  return api(`/api/auth/social/${flow.provider}/callback?state=${flow.url.searchParams.get('state')}&code=${code}`, {
    cookie: `${flow.cookie}${extraCookie ? `; ${extraCookie}` : ''}`,
  });
}

async function registerSocial(handle = 'oauth-learner', provider: SocialProviderId = 'github') {
  const flow = await start(registration(handle), provider);
  const response = await finish(flow);
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe('/');
  const session = cookie(response, sessionCookie);
  const identity = sessionSchema.parse(await (await api('/api/auth/me', { cookie: session })).json());
  if (!identity.user || !identity.csrfToken) throw new Error('The provider did not establish a learner session.');
  return { cookie: session, csrf: identity.csrfToken, user: identity.user };
}

describe('social sign-in protocol and account boundaries', () => {
  it('exposes available provider names, never client credentials or disabled options', async () => {
    const configuration = configSchema.parse(await (await api('/api/config')).json());
    expect(configuration.authProviders).toEqual([{ id: 'github', name: 'GitHub' }, { id: 'microsoft', name: 'Microsoft' }]);
    expect(JSON.stringify(configuration)).not.toContain(env.GITHUB_CLIENT_SECRET);
    expect(JSON.stringify(configuration)).not.toContain(clientId);
    env.GITHUB_CLIENT_SECRET = undefined;
    expect(configSchema.parse(await (await api('/api/config')).json()).authProviders).toEqual([{ id: 'microsoft', name: 'Microsoft' }]);
    expect((await api('/api/auth/social/github/start', { method: 'POST', body: { intent: 'login' } })).status).toBe(503);
  });

  it('requires same-origin starts, current explicit consent, and an exact public API allowlist', async () => {
    expect((await api('/api/auth/social/github/start', { method: 'POST', body: registration('one'), headers: { Origin: 'https://attacker.example' } })).status).toBe(403);
    expect((await api('/api/auth/social/github/start', { method: 'POST', body: { ...registration('one'), accepted: false } })).status).toBe(400);
    expect((await api('/api/auth/social/github/start', { method: 'POST', body: { ...registration('one'), privacyVersion: 'old' } })).status).toBe(400);
    expect((await api('/api/auth/social/github/start', { method: 'POST', body: { ...registration('one'), role: 'moderator' } })).status).toBe(400);
    expect((await api('/api/auth/social/github/start', { method: 'POST', body: { intent: 'login', returnTo: 'https://attacker.example' } })).status).toBe(400);
    expect((await api('/api/auth/social/unknown/start', { method: 'POST', body: { intent: 'login' } })).status).toBe(401);
    expect((await api('/api/auth/social/github/callback', { method: 'POST', body: {} })).status).toBe(401);
    env.LEGAL_APPROVED = 'false';
    expect((await api('/api/auth/social/github/start', { method: 'POST', body: registration('one') })).status).toBe(503);
  });

  it('binds a one-use state to the browser and provider, with S256 PKCE and a Lax flow cookie', async () => {
    const flow = await start(registration('state-test'));
    const cookies = flow.response.headers.getSetCookie().join('\n');
    expect(cookies).toContain('__Host-srk-oauth=');
    expect(cookies).toContain('SameSite=Lax');
    expect(cookies).toContain('HttpOnly');
    expect(cookies).toContain('Secure');
    expect(flow.url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(flow.url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(flow.url.searchParams.get('scope')).toBe('');
    const row = z.object({ state_hash: z.string(), browser_hash: z.string(), verifier: z.string() })
      .parse(await db.prepare('SELECT * FROM oauth_flows').first());
    expect(row.state_hash).not.toBe(flow.url.searchParams.get('state'));
    expect(row.browser_hash).not.toBe(flow.cookie.split('=')[1]);
    const wrongProvider = await api(`/api/auth/social/microsoft/callback?state=${flow.url.searchParams.get('state')}&code=test`, { cookie: flow.cookie });
    expect(wrongProvider.headers.get('location')).toBe('/?authError=expired');
    const wrongBrowser = await api(`/api/auth/social/github/callback?state=${flow.url.searchParams.get('state')}&code=test`, { cookie: `${stateCookie}=${randomToken()}` });
    expect(wrongBrowser.headers.get('location')).toBe('/?authError=expired');
    const completed = await finish(flow);
    expect(completed.headers.get('location')).toBe('/');
    const tokenRequest = networkRequests.find((entry) => entry.url.endsWith('/login/oauth/access_token'));
    const posted = new URLSearchParams(String(tokenRequest?.options.body));
    expect(posted.get('code_verifier')).toBe(row.verifier);
    expect(posted.get('redirect_uri')).toBe(`${origin}/api/auth/social/github/callback`);
    expect((await finish(flow)).headers.get('location')).toBe('/?authError=expired');
  });

  it('never creates a member from missing, expired, duplicated, cancelled, or replayed state', async () => {
    expect((await api('/api/auth/social/github/callback?code=test')).headers.get('location')).toBe('/?authError=expired');
    const expired = await start(registration('expired'));
    await db.prepare('UPDATE oauth_flows SET expires_at = ?').bind(now() - 1).run();
    expect((await finish(expired)).headers.get('location')).toBe('/?authError=expired');
    const cancelled = await start(registration('cancelled'));
    const state = cancelled.url.searchParams.get('state');
    expect((await api(`/api/auth/social/github/callback?state=${state}&state=${state}&code=test`, { cookie: cancelled.cookie })).headers.get('location')).toBe('/?authError=expired');
    expect((await api(`/api/auth/social/github/callback?state=${state}&error=access_denied&error_description=secret`, { cookie: cancelled.cookie })).headers.get('location')).toBe('/?authError=cancelled');
    expect(await db.prepare('SELECT COUNT(*) AS count FROM users').first('count')).toBe(0);
    expect(networkRequests.some((entry) => entry.url === 'https://api.github.com/user')).toBe(false);
  });

  it('registers without a passkey, keeps a strict session, defaults to learner, and stores no provider tokens or emails', async () => {
    const user = await registerSocial();
    expect(user.user.role).toBe('learner');
    expect(await db.prepare('SELECT COUNT(*) AS count FROM passkeys').first('count')).toBe(0);
    const identity = sessionSchema.parse(await (await api('/api/auth/me', { cookie: user.cookie })).json());
    expect(identity.authMethods).toEqual(['github']);
    expect((await api('/api/catalog', { cookie: user.cookie })).status).toBe(200);
    const exportResponse = await api('/api/account/export', { cookie: user.cookie });
    expect(exportResponse.status).toBe(200);
    const exported = await exportResponse.text();
    expect(exported).toContain('linkedIdentities');
    expect(exported).not.toContain(githubToken);
    expect(exported).not.toContain('shared@example.test');
    expect(exported).not.toContain('test-only-github-secret');
    const login = await start({ intent: 'login' });
    const response = await finish(login);
    expect(response.headers.getSetCookie().find((entry) => entry.startsWith(`${sessionCookie}=`))).toContain('SameSite=Strict');
    expect(cookie(response, sessionCookie)).not.toBe(user.cookie);
  });

  it('uses immutable provider identity, never the same email or public display name', async () => {
    const github = await registerSocial('github-owner');
    githubId++;
    const stranger = await start({ intent: 'login' });
    expect((await finish(stranger)).headers.get('location')).toBe('/?authError=not-registered');
    const microsoft = await registerSocial('microsoft-owner', 'microsoft');
    expect(microsoft.user.id).not.toBe(github.user.id);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM users').first('count')).toBe(2);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM social_identities').first('count')).toBe(2);
    expect(microsoft.user.role).toBe('learner');
    const request = networkRequests.find((entry) => entry.url.endsWith('/oauth2/v2.0/token'));
    expect(new URLSearchParams(String(request?.options.body)).get('scope')).toBe('openid profile');
  });

  for (const defect of ['redirect', 'malformed', 'missing-id'] as const) {
    it(`rejects ${defect} provider responses without a success-shaped fallback`, async () => {
      const flow = await start(registration('bad-provider'));
      providerFailure = defect;
      expect((await finish(flow)).headers.get('location')).toMatch(/^\/\?authError=(?:invalid-identity|unavailable)$/u);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM users').first('count')).toBe(0);
      expect(networkRequests.every((entry) => entry.url.startsWith('https://github.com/') || entry.url.startsWith('https://api.github.com/') || entry.url.startsWith('https://challenges.cloudflare.com/'))).toBe(true);
      expect(networkRequests.filter((entry) => entry.url.includes('github')).every((entry) => entry.options.redirect === 'manual')).toBe(true);
    });
  }

  it('refuses unexpected GitHub permissions instead of acquiring repository or account-write access', async () => {
    const flow = await start(registration('overscoped'));
    githubScope = 'repo';
    expect((await finish(flow)).headers.get('location')).toBe('/?authError=invalid-identity');
    expect(networkRequests.some((entry) => entry.url === 'https://api.github.com/user')).toBe(false);
  });

  for (const defect of ['nonce', 'audience', 'issuer', 'signature', 'expired', 'missing-expiry', 'key-issuer'] as const) {
    it(`rejects a Microsoft identity with an invalid ${defect}`, async () => {
      const flow = await start(registration('microsoft-invalid'), 'microsoft');
      if (defect === 'nonce') msNonce = randomToken();
      if (defect === 'audience') msAudience = 'another-application';
      if (defect === 'issuer') msIssuer = 'https://attacker.example/issuer';
      if (defect === 'signature') msWrongSignature = true;
      if (defect === 'expired') msExpired = true;
      if (defect === 'missing-expiry') msMissingExpiry = true;
      if (defect === 'key-issuer') msKid = 'tenant-specific-key';
      expect((await finish(flow)).headers.get('location')).toBe('/?authError=invalid-identity');
      expect(await db.prepare('SELECT COUNT(*) AS count FROM users').first('count')).toBe(0);
    });
  }

  it('requires current authenticated CSRF and recent sign-in before linking a provider', async () => {
    const user = await registerSocial();
    expect((await api('/api/auth/social/microsoft/start', { method: 'POST', body: { intent: 'link' } })).status).toBe(401);
    expect((await api('/api/auth/social/microsoft/start', { method: 'POST', body: { intent: 'link' }, cookie: user.cookie })).status).toBe(403);
    await db.prepare('UPDATE sessions SET authenticated_at = ?').bind(now() - 301).run();
    expect((await api('/api/auth/social/microsoft/start', { method: 'POST', body: { intent: 'link' }, cookie: user.cookie, csrf: user.csrf })).status).toBe(403);
    expect((await api('/api/auth/social/microsoft/start', { method: 'POST', body: { intent: 'login' }, cookie: user.cookie })).status).toBe(409);
  });

  it('links through the Lax callback binding even when the Strict session is absent, and rotates the original session', async () => {
    const user = await registerSocial();
    const flow = await start({ intent: 'link' }, 'microsoft', user);
    const response = await finish(flow);
    expect(response.headers.get('location')).toBe('/');
    const current = cookie(response, sessionCookie);
    expect(sessionSchema.parse(await (await api('/api/auth/me', { cookie: user.cookie })).json()).user).toBeNull();
    const linked = sessionSchema.parse(await (await api('/api/auth/me', { cookie: current })).json());
    expect(linked.user?.id).toBe(user.user.id);
    expect(linked.authMethods.sort()).toEqual(['github', 'microsoft']);
  });

  it('rejects linking after logout', async () => {
    const user = await registerSocial();
    const flow = await start({ intent: 'link' }, 'microsoft', user);
    await api('/api/auth/logout', { method: 'POST', cookie: user.cookie, csrf: user.csrf });
    expect((await finish(flow)).headers.get('location')).toBe('/?authError=expired');
    expect(await db.prepare("SELECT COUNT(*) AS count FROM social_identities WHERE provider='microsoft'").first('count')).toBe(0);
  });

  it('rejects a linking callback when the browser is now signed into a different learner', async () => {
    const first = await registerSocial('original-learner');
    githubId++;
    const second = await registerSocial('different-learner');
    const flow = await start({ intent: 'link' }, 'microsoft', first);
    expect((await finish(flow, 'test-only-code', second.cookie)).headers.get('location')).toBe('/?authError=session-ended');
    expect(await db.prepare("SELECT COUNT(*) AS count FROM social_identities WHERE provider='microsoft'").first('count')).toBe(0);
    expect(sessionSchema.parse(await (await api('/api/auth/me', { cookie: second.cookie })).json()).user?.id).toBe(second.user.id);
  });

  it('cannot attach an identity already owned by another learner', async () => {
    const first = await registerSocial('first-owner');
    githubId++;
    const second = await registerSocial('second-owner');
    const microsoft = await start({ intent: 'link' }, 'microsoft', first);
    expect((await finish(microsoft)).headers.get('location')).toBe('/');
    const hijack = await start({ intent: 'link' }, 'microsoft', second);
    expect((await finish(hijack)).headers.get('location')).toBe('/?authError=already-linked');
    expect(await db.prepare("SELECT user_id FROM social_identities WHERE provider='microsoft'").first('user_id')).toBe(first.user.id);
  });

  it('reauthenticates only the linked identity for the original session, never another account', async () => {
    const user = await registerSocial();
    await db.prepare('UPDATE sessions SET authenticated_at = ?').bind(now() - 301).run();
    expect((await api('/api/account/export', { cookie: user.cookie })).status).toBe(403);
    const wrong = await start({ intent: 'reauth' }, 'github', user);
    githubId++;
    expect((await finish(wrong)).headers.get('location')).toBe('/?authError=wrong-account');
    githubId--;
    const correct = await start({ intent: 'reauth' }, 'github', user);
    const response = await finish(correct);
    const refreshed = cookie(response, sessionCookie);
    expect(refreshed).not.toBe(user.cookie);
    expect((await api('/api/account/export', { cookie: refreshed })).status).toBe(200);
    expect(sessionSchema.parse(await (await api('/api/auth/me', { cookie: user.cookie })).json()).user).toBeNull();
  });

  it('keeps outdated consent from opening the member catalog after social sign-in', async () => {
    const user = await registerSocial();
    await db.prepare('UPDATE users SET privacy_version = ? WHERE id = ?').bind('old', user.user.id).run();
    const login = await start({ intent: 'login' });
    const response = await finish(login);
    const current = cookie(response, sessionCookie);
    expect(sessionSchema.parse(await (await api('/api/auth/me', { cookie: current })).json()).needsConsent).toBe(true);
    expect((await api('/api/catalog', { cookie: current })).status).toBe(428);
  });

  it('protects the last usable sign-in method and permits removal once a passkey exists', async () => {
    const user = await registerSocial();
    expect((await api('/api/auth/social/github', { method: 'DELETE', cookie: user.cookie, csrf: user.csrf })).status).toBe(409);
    await db.prepare('INSERT INTO passkeys (id,user_id,public_key,counter,transports,device_type,backed_up,created_at) VALUES (?, ?, ?, 0, ?, ?, 0, ?)')
      .bind('test-passkey', user.user.id, 'test-public-key', '[]', 'singleDevice', now()).run();
    expect((await api('/api/auth/passkeys/test-passkey', { method: 'DELETE', cookie: user.cookie, csrf: user.csrf })).status).toBe(200);
    await db.prepare('INSERT INTO passkeys (id,user_id,public_key,counter,transports,device_type,backed_up,created_at) VALUES (?, ?, ?, 0, ?, ?, 0, ?)')
      .bind('test-passkey', user.user.id, 'test-public-key', '[]', 'singleDevice', now()).run();
    expect((await api('/api/auth/social/github', { method: 'DELETE', cookie: user.cookie, csrf: user.csrf })).status).toBe(200);
    expect((await api('/api/auth/passkeys/test-passkey', { method: 'DELETE', cookie: user.cookie, csrf: user.csrf })).status).toBe(409);
  });

  it('does not count a disabled provider as a usable backup when deleting a passkey', async () => {
    const user = await registerSocial();
    await db.prepare('INSERT INTO passkeys (id,user_id,public_key,counter,transports,device_type,backed_up,created_at) VALUES (?, ?, ?, 0, ?, ?, 0, ?)')
      .bind('test-passkey', user.user.id, 'test-public-key', '[]', 'singleDevice', now()).run();
    env.GITHUB_CLIENT_SECRET = undefined;
    expect((await api('/api/auth/passkeys/test-passkey', { method: 'DELETE', cookie: user.cookie, csrf: user.csrf })).status).toBe(409);
  });

  it('cancels a pending linking flow when a sign-in method is removed', async () => {
    const user = await registerSocial();
    await db.prepare('INSERT INTO passkeys (id,user_id,public_key,counter,transports,device_type,backed_up,created_at) VALUES (?, ?, ?, 0, ?, ?, 0, ?)')
      .bind('test-passkey', user.user.id, 'test-public-key', '[]', 'singleDevice', now()).run();
    const flow = await start({ intent: 'link' }, 'microsoft', user);
    expect((await api('/api/auth/social/github', {
      method: 'DELETE', cookie: `${user.cookie}; ${flow.cookie}`, csrf: user.csrf,
    })).status).toBe(200);
    expect((await finish(flow)).headers.get('location')).toBe('/?authError=expired');
    expect(await db.prepare('SELECT COUNT(*) AS count FROM social_identities').first('count')).toBe(0);
  });
  it('serializes simultaneous removals so they cannot remove both remaining methods', async () => {
    const user = await registerSocial();
    await db.prepare('INSERT INTO passkeys (id,user_id,public_key,counter,transports,device_type,backed_up,created_at) VALUES (?, ?, ?, 0, ?, ?, 0, ?)')
      .bind('test-passkey', user.user.id, 'test-public-key', '[]', 'singleDevice', now()).run();
    const results = await Promise.all([
      api('/api/auth/passkeys/test-passkey', { method: 'DELETE', cookie: user.cookie, csrf: user.csrf }),
      api('/api/auth/social/github', { method: 'DELETE', cookie: user.cookie, csrf: user.csrf }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await db.prepare('SELECT (SELECT COUNT(*) FROM passkeys) + (SELECT COUNT(*) FROM social_identities) AS count').first('count')).toBe(1);
  });
  it('deletes linked identities and pending OAuth flows with the learner account', async () => {
    const user = await registerSocial();
    await start({ intent: 'link' }, 'microsoft', user);
    expect((await api('/api/account', { method: 'DELETE', cookie: user.cookie, csrf: user.csrf, body: { confirmHandle: user.user.handle } })).status).toBe(200);
    for (const table of ['users', 'social_identities', 'oauth_flows', 'sessions']) {
      expect(await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first('count')).toBe(0);
    }
  });

  it('preserves the newly issued session when a social account reaches its session cap', async () => {
    await registerSocial();
    let newest = '';
    for (let index = 0; index < 6; index++) {
      const flow = await start({ intent: 'login' });
      newest = cookie(await finish(flow), sessionCookie);
    }
    expect(await db.prepare('SELECT COUNT(*) AS count FROM sessions').first('count')).toBe(5);
    expect(sessionSchema.parse(await (await api('/api/auth/me', { cookie: newest })).json()).user?.handle).toBe('oauth-learner');
    const raw = newest.split('=')[1];
    if (!raw) throw new Error('Missing session token.');
    expect(await db.prepare('SELECT token_hash FROM sessions WHERE token_hash = ?').bind(await sha256(raw)).first('token_hash')).not.toBe(raw);
  });

  it('returns the management link only for the pinned personal GitHub identity, regardless of public handle', async () => {
    const wrong = await registerSocial('oguzhanf');
    const untrusted = sessionSchema.parse(await (await api('/api/auth/me', { cookie: wrong.cookie })).json());
    expect(untrusted.managementLink).toBeUndefined();
    for (const path of ['/management', '/management/hidden', '/api/management/overview', '/api/management/accounts', '/api/management/requests']) {
      expect((await api(path, { cookie: wrong.cookie })).status, path).toBe(403);
    }
    await db.prepare("UPDATE users SET role='moderator' WHERE id=?").bind(wrong.user.id).run();
    expect((await api('/api/management/overview', { cookie: wrong.cookie })).status).toBe(403);
    githubId = Number(MANAGEMENT_GITHUB_USER_ID);
    const owner = await registerSocial('personal-owner');
    const trusted = sessionSchema.parse(await (await api('/api/auth/me', { cookie: owner.cookie })).json());
    expect(trusted.user?.role).toBe('learner');
    expect(trusted.managementLink).toEqual({ href: '/management', label: 'Site management' });
    expect((await api('/management', { cookie: owner.cookie })).status).toBe(200);
    expect((await api('/api/management/overview')).status).toBe(401);
    expect((await api('/management')).status).toBe(303);
    const overview = managementOverviewSchema.parse(await (await api('/api/management/overview', { cookie: owner.cookie })).json());
    expect(overview.accounts).toBe(2);
    expect(overview.publishedTopics).toBe(lessons.length);
    expect(managementAccountsSchema.parse(await (await api('/api/management/accounts', { cookie: owner.cookie })).json())).toHaveLength(2);
    expect(managementAuditSchema.parse(await (await api('/api/management/audit', { cookie: owner.cookie })).json())).toEqual([]);
    expect(managementReferencesSchema.parse(await (await api('/api/management/references', { cookie: owner.cookie })).json()).length).toBeGreaterThan(0);
  });

  it('lets only the owner use management review routes, with CSRF and current authentication', async () => {
    githubId = Number(MANAGEMENT_GITHUB_USER_ID);
    const owner = await registerSocial('owner-reviewer');
    const commentId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    await db.prepare("INSERT INTO comments (id,page_id,author_id,body,status,created_at) VALUES (?, 'home', ?, ?, 'pending', ?)")
      .bind(commentId, owner.user.id, 'Synthetic contribution for management review.', now()).run();
    await db.prepare("INSERT INTO contact_requests (id,message,created_at) VALUES (?, ?, ?)")
      .bind(requestId, 'Synthetic private request for the site owner.', now()).run();
    expect((await api('/api/management/contributions', { cookie: owner.cookie })).status).toBe(200);
    expect((await api('/api/management/requests', { cookie: owner.cookie })).status).toBe(200);
    expect((await api(`/api/management/contributions/${commentId}`, { method: 'POST', cookie: owner.cookie, body: { action: 'publish' } })).status).toBe(403);
    expect((await api(`/api/management/contributions/${commentId}`, { method: 'POST', cookie: owner.cookie, csrf: owner.csrf, body: { action: 'publish' } })).status).toBe(200);
    expect(await db.prepare('SELECT status FROM comments WHERE id=?').bind(commentId).first('status')).toBe('published');
    expect((await api(`/api/management/requests/${requestId}/resolve`, { method: 'POST', cookie: owner.cookie, csrf: owner.csrf })).status).toBe(200);
    expect(await db.prepare('SELECT status FROM contact_requests WHERE id=?').bind(requestId).first('status')).toBe('resolved');
    await db.prepare('UPDATE sessions SET authenticated_at=?').bind(now() - 301).run();
    expect((await api('/api/management/overview', { cookie: owner.cookie })).status).toBe(403);
    expect((await api('/api/management/requests', { cookie: owner.cookie })).status).toBe(403);
  });

  it('removes management access immediately if the pinned GitHub identity is unlinked or replaced', async () => {
    githubId = Number(MANAGEMENT_GITHUB_USER_ID);
    const owner = await registerSocial('owner-revocation');
    await db.prepare("DELETE FROM social_identities WHERE user_id=?").bind(owner.user.id).run();
    expect(sessionSchema.parse(await (await api('/api/auth/me', { cookie: owner.cookie })).json()).managementLink).toBeUndefined();
    expect((await api('/management', { cookie: owner.cookie })).status).toBe(403);
    expect((await api('/api/management/overview', { cookie: owner.cookie })).status).toBe(403);
    const otherHash = await sha256(JSON.stringify(['github', 'https://github.com', '123456789']));
    await db.prepare("INSERT INTO social_identities (provider,identity_hash,user_id,created_at) VALUES ('github',?,?,?)")
      .bind(otherHash, owner.user.id, now()).run();
    expect((await api('/api/management/overview', { cookie: owner.cookie })).status).toBe(403);
  });
});
