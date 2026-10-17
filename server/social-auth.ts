import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { PRIVACY_VERSION, TERMS_VERSION } from '../shared/contracts';
import {
  CHALLENGE_SECONDS, FRESH_AUTH_SECONDS, cancelAuthFlows, clearAuthCookie, encodeBytes, getAuthCookie,
  issueSession, now, randomToken, rateLimit, readSession, requireCommunityEnabled, requireSession,
  sameToken, setAuthCookie, sha256, verifyTurnstile,
} from './security';
import {
  SocialProviderError, configuredSocialProviders, exchangeSocialCode, socialCallbackUrl, socialCredentials,
} from './social-providers';
import { handleSchema, readJson, registrationStartSchema } from './validation';
import type { AppEnv } from './types';
import type { SocialProviderId } from '../shared/contracts';

const providerSchema = z.enum(['microsoft', 'github']);
const startSchema = z.discriminatedUnion('intent', [
  registrationStartSchema.extend({ intent: z.literal('register') }),
  z.object({ intent: z.enum(['login', 'link', 'reauth']) }).strict(),
]);
const payloadSchema = z.object({
  userId: z.uuid(), handle: handleSchema,
  termsVersion: z.literal(TERMS_VERSION), privacyVersion: z.literal(PRIVACY_VERSION),
}).strict();
const flowSchema = z.object({
  provider: providerSchema, intent: z.enum(['register', 'login', 'link', 'reauth']),
  client_id: z.string(), verifier: z.string().regex(/^[a-f0-9]{64}$/u),
  nonce_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  payload: z.string(), user_id: z.uuid().nullable(), session_hash: z.string().nullable(),
  created_at: z.number().int(),
});
type SocialFailure = 'expired' | 'cancelled' | 'unavailable' | 'invalid-identity' | 'not-registered' |
  'already-registered' | 'already-linked' | 'wrong-account' | 'session-ended' | 'handle-taken' | 'consent-changed';

class SocialAuthError extends Error {
  constructor(public readonly reason: SocialFailure) {
    super('Social sign-in could not be completed.');
    this.name = 'SocialAuthError';
  }
}

export const socialAuth = new Hono<AppEnv>();

function providerFromPath(value: string): SocialProviderId {
  const parsed = providerSchema.safeParse(value);
  if (!parsed.success) throw new HTTPException(404, { message: 'Unknown sign-in provider.' });
  return parsed.data;
}

socialAuth.post('/:provider/start', async (c) => {
  requireCommunityEnabled(c);
  const provider = providerFromPath(c.req.param('provider'));
  let credentials;
  try { credentials = socialCredentials(c.env, provider); }
  catch (error) {
    if (error instanceof SocialProviderError) throw new HTTPException(503, { message: 'This sign-in method is currently unavailable.' });
    throw error;
  }
  const input = await readJson(c, startSchema);
  let userId: string | null = null;
  let sessionHash: string | null = null;
  let payload = '{}';
  if (input.intent === 'link' || input.intent === 'reauth') {
    const session = requireSession(c, { fresh: input.intent === 'link', currentConsent: input.intent === 'link' });
    userId = session.user_id;
    sessionHash = session.token_hash;
    if (input.intent === 'reauth') {
      const linked = await c.env.DB.prepare('SELECT provider FROM social_identities WHERE user_id = ? AND provider = ?')
        .bind(userId, provider).first();
      if (!linked) throw new HTTPException(409, { message: 'Use a sign-in method already linked to this account.' });
    }
  } else if (c.get('session')) {
    throw new HTTPException(409, { message: 'Use My account to link a sign-in method, or sign out before using another account.' });
  }
  if (input.intent === 'register') {
    const existing = await c.env.DB.prepare('SELECT id FROM users WHERE handle = ?').bind(input.handle).first();
    if (existing) throw new HTTPException(409, { message: 'That public handle is already registered.' });
    await verifyTurnstile(c, input.turnstileToken, 'register');
    payload = JSON.stringify({
      userId: crypto.randomUUID(), handle: input.handle, termsVersion: input.termsVersion, privacyVersion: input.privacyVersion,
    });
  }
  await cancelAuthFlows(c);
  const state = randomToken();
  const browser = randomToken();
  const verifier = randomToken();
  const nonce = randomToken();
  const challenge = encodeBytes(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const time = now();
  await c.env.DB.prepare(
    'INSERT INTO oauth_flows (state_hash, browser_hash, provider, intent, client_id, verifier, nonce_hash, payload, user_id, session_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(await sha256(state), await sha256(browser), provider, input.intent, credentials.clientId, verifier,
    await sha256(nonce), payload, userId, sessionHash, time, time + CHALLENGE_SECONDS).run();
  setAuthCookie(c, 'oauth', browser, CHALLENGE_SECONDS);
  const url = new URL(provider === 'microsoft'
    ? 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
    : 'https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', credentials.clientId);
  url.searchParams.set('redirect_uri', socialCallbackUrl(c.env, provider));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', provider === 'microsoft' && input.intent === 'reauth' ? 'login' : 'select_account');
  url.searchParams.set('scope', provider === 'microsoft' ? 'openid profile' : '');
  if (provider === 'microsoft') {
    url.searchParams.set('response_mode', 'query');
    url.searchParams.set('nonce', nonce);
  }
  return c.json({ provider, authorizationUrl: url.href });
});

socialAuth.get('/:provider/callback', async (c) => {
  const provider = providerFromPath(c.req.param('provider'));
  try {
    requireCommunityEnabled(c);
    await rateLimit(c, 'social-callback', 120, 600);
    const requestUrl = new URL(c.req.url);
    if (requestUrl.origin !== c.env.APP_ORIGIN || requestUrl.search.length > 16384) throw new SocialAuthError('invalid-identity');
    const state = requestUrl.searchParams.get('state');
    const browser = getAuthCookie(c, 'oauth');
    if (!state || !/^[a-f0-9]{64}$/u.test(state) || !browser ||
      ['state', 'code', 'error'].some((key) => requestUrl.searchParams.getAll(key).length > 1)) {
      throw new SocialAuthError('expired');
    }
    const stored = await c.env.DB.prepare(
      'DELETE FROM oauth_flows WHERE state_hash = ? AND browser_hash = ? AND provider = ? AND expires_at > ? RETURNING provider, intent, client_id, verifier, nonce_hash, payload, user_id, session_hash, created_at',
    ).bind(await sha256(state), await sha256(browser), provider, now()).first();
    if (!stored) throw new SocialAuthError('expired');
    clearAuthCookie(c, 'oauth');
    const flow = flowSchema.parse(stored);
    const credentials = socialCredentials(c.env, provider);
    if (flow.client_id !== credentials.clientId) throw new SocialAuthError('expired');
    if (requestUrl.searchParams.has('error')) throw new SocialAuthError('cancelled');
    const code = requestUrl.searchParams.get('code');
    if (!code || code.length > 8192 || /[\s\u007f]/u.test(code)) throw new SocialAuthError('invalid-identity');
    const identity = await exchangeSocialCode(c.env, provider, code, flow.verifier);
    if (identity.provider === 'microsoft' && !sameToken(await sha256(identity.nonce), flow.nonce_hash)) {
      throw new SocialAuthError('invalid-identity');
    }
    const identityHash = await sha256(JSON.stringify([identity.provider, identity.issuer, identity.subject]));
    const linked = await c.env.DB.prepare('SELECT user_id FROM social_identities WHERE provider = ? AND identity_hash = ?')
      .bind(provider, identityHash).first<{ user_id: string }>();

    if (flow.intent === 'register') {
      if (linked) throw new SocialAuthError('already-registered');
      const parsed = payloadSchema.safeParse(JSON.parse(flow.payload));
      if (!parsed.success) throw new SocialAuthError('consent-changed');
      const input = parsed.data;
      const time = now();
      try {
        await c.env.DB.batch([
          c.env.DB.prepare('INSERT INTO users (id, handle, terms_version, privacy_version, accepted_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(input.userId, input.handle, TERMS_VERSION, PRIVACY_VERSION, time, time),
          c.env.DB.prepare('INSERT INTO social_identities (provider, identity_hash, user_id, created_at) VALUES (?, ?, ?, ?)')
            .bind(provider, identityHash, input.userId, time),
          c.env.DB.prepare('INSERT INTO consents (user_id, terms_version, privacy_version, accepted_at) VALUES (?, ?, ?, ?)')
            .bind(input.userId, TERMS_VERSION, PRIVACY_VERSION, time),
        ]);
      } catch (error) {
        if (error instanceof Error && error.message.includes('UNIQUE constraint failed: users.handle')) throw new SocialAuthError('handle-taken');
        if (error instanceof Error && error.message.includes('UNIQUE constraint failed: social_identities')) throw new SocialAuthError('already-registered');
        throw error;
      }
      await issueSession(c, input.userId);
      return c.redirect('/', 303);
    }
    if (flow.intent === 'login') {
      if (!linked) throw new SocialAuthError('not-registered');
      await issueSession(c, linked.user_id);
      return c.redirect('/', 303);
    }

    if (!flow.user_id || !flow.session_hash) throw new SocialAuthError('session-ended');
    const original = await readSession(c, flow.session_hash);
    const current = c.get('session');
    if (!original || original.user_id !== flow.user_id || (current && current.token_hash !== flow.session_hash)) {
      throw new SocialAuthError('session-ended');
    }
    if (flow.intent === 'reauth') {
      if (!linked || linked.user_id !== original.user_id) throw new SocialAuthError('wrong-account');
      c.set('session', original);
      await issueSession(c, original.user_id);
      return c.redirect('/', 303);
    }
    if (linked) throw new SocialAuthError('already-linked');
    if (now() - original.authenticated_at > FRESH_AUTH_SECONDS) throw new SocialAuthError('session-ended');
    try {
      const attached = await c.env.DB.prepare(
        'INSERT INTO social_identities (provider, identity_hash, user_id, created_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.user_id = ? AND s.expires_at > ? AND s.authenticated_at >= ? AND u.terms_version = ? AND u.privacy_version = ?) RETURNING provider',
      ).bind(provider, identityHash, original.user_id, now(), original.token_hash, original.user_id,
        now(), now() - FRESH_AUTH_SECONDS, TERMS_VERSION, PRIVACY_VERSION).first();
      if (!attached) throw new SocialAuthError('session-ended');
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed: social_identities')) throw new SocialAuthError('already-linked');
      throw error;
    }
    c.set('session', original);
    await issueSession(c, original.user_id);
    return c.redirect('/', 303);
  } catch (error) {
    let reason: SocialFailure;
    if (error instanceof SocialAuthError || error instanceof SocialProviderError) reason = error.reason;
    else if (error instanceof HTTPException && error.status === 503) reason = 'unavailable';
    else throw error;
    console.warn(JSON.stringify({ event: 'social_signin_rejected', requestId: c.get('requestId'), provider, reason }));
    return c.redirect(`/?authError=${reason}`, 303);
  }
});

socialAuth.delete('/:provider', async (c) => {
  const session = requireSession(c, { fresh: true });
  const provider = providerFromPath(c.req.param('provider'));
  const available = JSON.stringify(configuredSocialProviders(c.env).map((entry) => entry.id));
  const result = await c.env.DB.batch<{ provider: string }>([
    c.env.DB.prepare(
      'DELETE FROM social_identities WHERE user_id = ? AND provider = ? AND ((SELECT COUNT(*) FROM passkeys WHERE user_id = ?) + (SELECT COUNT(*) FROM social_identities WHERE user_id = ? AND provider != ? AND provider IN (SELECT value FROM json_each(?)))) > 0 RETURNING provider',
    ).bind(session.user_id, provider, session.user_id, session.user_id, provider, available),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ? AND changes() = 1')
      .bind(session.user_id, session.token_hash),
  ]);
  if (result[0]?.results[0]?.provider !== provider) {
    throw new HTTPException(409, { message: 'Sign-in method not found, not owned by you, or it is your last available method. Add another method first.' });
  }
  await cancelAuthFlows(c);
  return c.json({ removed: true });
});
