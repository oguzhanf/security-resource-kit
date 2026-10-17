import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { VerifiedRegistrationResponse } from '@simplewebauthn/server';
import { PRIVACY_VERSION, TERMS_VERSION } from '../shared/contracts';
import {
  CHALLENGE_SECONDS, cancelAuthFlows, clearAuthCookie, decodeBytes, encodeBytes, getAuthCookie,
  issueSession, now, randomToken, rateLimit, requireCommunityEnabled,
  requireSession, setAuthCookie, sha256, verifyTurnstile,
} from './security';
import {
  authenticationResponseSchema, challengePayloadSchema, readJson,
  registrationResponseSchema, registrationStartSchema,
} from './validation';
import type { AppContext, AppEnv } from './types';
import { z } from 'zod';
import { configuredSocialProviders } from './social-providers';
import type { AuthMethod, SocialProviderId } from '../shared/contracts';
import { canManageSite } from './management-access';

type ChallengePayload = z.infer<typeof challengePayloadSchema>;
interface ChallengeRow { challenge: string; payload: string }
interface PasskeyRow {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string;
}

async function saveChallenge(c: AppContext, kind: 'register' | 'login' | 'add-passkey', challenge: string, payload: ChallengePayload): Promise<void> {
  await cancelAuthFlows(c);
  const token = randomToken();
  const statements = [
    c.env.DB.prepare('INSERT INTO auth_challenges (id_hash, kind, challenge, payload, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(await sha256(token), kind, challenge, JSON.stringify(payload), now() + CHALLENGE_SECONDS),
  ];
  await c.env.DB.batch(statements);
  setAuthCookie(c, 'flow', token, CHALLENGE_SECONDS);
}

async function consumeChallenge(c: AppContext, kind: 'register' | 'login' | 'add-passkey'): Promise<{ challenge: string; payload: ChallengePayload }> {
  const token = getAuthCookie(c, 'flow');
  clearAuthCookie(c, 'flow');
  if (!token) throw new HTTPException(400, { message: 'Passkey challenge is missing. Start again.' });
  const row = await c.env.DB.prepare(
    'DELETE FROM auth_challenges WHERE id_hash = ? AND kind = ? AND expires_at > ? RETURNING challenge, payload',
  ).bind(await sha256(token), kind, now()).first<ChallengeRow>();
  if (!row) throw new HTTPException(400, { message: 'Passkey challenge expired or was already used. Start again.' });
  return { challenge: row.challenge, payload: challengePayloadSchema.parse(JSON.parse(row.payload)) };
}

async function verifyRegistration(c: AppContext, challenge: string): Promise<Extract<VerifiedRegistrationResponse, { verified: true }>> {
  const response = await readJson(c, registrationResponseSchema);
  if (response.id !== response.rawId) throw new HTTPException(400, { message: 'Credential identifiers do not match.' });
  let verification: VerifiedRegistrationResponse;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: c.env.APP_ORIGIN,
      expectedRPID: c.env.RP_ID,
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7, -257],
    });
  } catch (error) {
    console.warn(JSON.stringify({ event: 'passkey_registration_rejected', requestId: c.get('requestId'), error: error instanceof Error ? error.name : 'unknown' }));
    throw new HTTPException(400, { message: 'Passkey verification failed. Start again with a supported passkey.' });
  }
  if (!verification.verified) throw new HTTPException(400, { message: 'Passkey verification failed. Start again.' });
  return verification;
}

function passkeyInsert(c: AppContext, userId: string, result: Extract<VerifiedRegistrationResponse, { verified: true }>): D1PreparedStatement {
  const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
  return c.env.DB.prepare(
    'INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM passkeys WHERE user_id = ?) < 5',
  ).bind(credential.id, userId, encodeBytes(credential.publicKey), credential.counter,
    JSON.stringify(credential.transports || []), credentialDeviceType, Number(credentialBackedUp), now(), userId);
}

function registrationOptions(c: AppContext, userId: string, handle: string, excludeCredentials: { id: string }[] = []) {
  return generateRegistrationOptions({
    rpName: 'Security Resource Kit',
    rpID: c.env.RP_ID,
    userID: Uint8Array.from(new TextEncoder().encode(userId)),
    userName: handle,
    userDisplayName: handle,
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    supportedAlgorithmIDs: [-7, -257],
    excludeCredentials,
    timeout: 120000,
  });
}

export const auth = new Hono<AppEnv>();

auth.get('/me', async (c) => {
  const session = c.get('session');
  const methods: AuthMethod[] = [];
  if (session) {
    const records = await c.env.DB.batch([
      c.env.DB.prepare('SELECT COUNT(*) AS count FROM passkeys WHERE user_id = ?').bind(session.user_id),
      c.env.DB.prepare('SELECT provider FROM social_identities WHERE user_id = ?').bind(session.user_id),
    ]);
    if (z.object({ count: z.number().int() }).parse(records[0]?.results[0]).count > 0) methods.push('passkey');
    const linked = z.array(z.object({ provider: z.enum(['microsoft', 'github']) })).parse(records[1]?.results);
    const available = configuredSocialProviders(c.env).map((entry) => entry.id);
    methods.push(...linked.map((entry) => entry.provider).filter((id) => available.includes(id)));
  }
  return c.json({
    user: session ? { id: session.user_id, handle: session.handle, role: session.role } : null,
    csrfToken: session?.csrf_token || null,
    authenticatedAt: session?.authenticated_at,
    expiresAt: session?.expires_at,
    needsConsent: session ? session.terms_version !== TERMS_VERSION || session.privacy_version !== PRIVACY_VERSION : false,
    authMethods: methods,
    ...(session && session.terms_version === TERMS_VERSION && session.privacy_version === PRIVACY_VERSION &&
      await canManageSite(c, session) ? { managementLink: { href: '/management', label: 'Site management' } } : {}),
  });
});

auth.use('/*', async (c, next) => {
  if (c.req.method === 'POST') await rateLimit(c, 'authentication', 60, 600);
  await next();
});

auth.post('/register/options', async (c) => {
  requireCommunityEnabled(c);
  const input = await readJson(c, registrationStartSchema);
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE handle = ?').bind(input.handle).first();
  if (existing) throw new HTTPException(409, { message: 'That public handle is already registered.' });
  await verifyTurnstile(c, input.turnstileToken, 'register');
  const userId = crypto.randomUUID();
  const options = await registrationOptions(c, userId, input.handle);
  await saveChallenge(c, 'register', options.challenge, {
    userId, handle: input.handle, termsVersion: input.termsVersion, privacyVersion: input.privacyVersion,
  });
  return c.json(options);
});

auth.post('/register/verify', async (c) => {
  requireCommunityEnabled(c);
  const { challenge, payload } = await consumeChallenge(c, 'register');
  if (!payload.userId || !payload.handle || payload.termsVersion !== TERMS_VERSION || payload.privacyVersion !== PRIVACY_VERSION) {
    throw new HTTPException(400, { message: 'Registration consent is missing or outdated. Start again.' });
  }
  const verification = await verifyRegistration(c, challenge);
  const time = now();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO users (id, handle, terms_version, privacy_version, accepted_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(payload.userId, payload.handle, TERMS_VERSION, PRIVACY_VERSION, time, time),
      c.env.DB.prepare('INSERT INTO consents (user_id, terms_version, privacy_version, accepted_at) VALUES (?, ?, ?, ?)')
        .bind(payload.userId, TERMS_VERSION, PRIVACY_VERSION, time),
      passkeyInsert(c, payload.userId, verification),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed: users.handle')) {
      throw new HTTPException(409, { message: 'That handle was just registered. Choose another handle and start again.' });
    }
    throw error;
  }
  await issueSession(c, payload.userId);
  return c.json({ registered: true }, 201);
});

auth.post('/login/options', async (c) => {
  requireCommunityEnabled(c);
  const options = await generateAuthenticationOptions({
    rpID: c.env.RP_ID, userVerification: 'required', allowCredentials: [], timeout: 120000,
  });
  await saveChallenge(c, 'login', options.challenge, {});
  return c.json(options);
});

auth.post('/login/verify', async (c) => {
  requireCommunityEnabled(c);
  const { challenge } = await consumeChallenge(c, 'login');
  const response = await readJson(c, authenticationResponseSchema);
  const credential = await c.env.DB.prepare('SELECT * FROM passkeys WHERE id = ?').bind(response.id).first<PasskeyRow>();
  if (!credential || response.rawId !== response.id || !response.response.userHandle ||
    encodeBytes(new TextEncoder().encode(credential.user_id)) !== response.response.userHandle) {
    throw new HTTPException(400, { message: 'Passkey verification failed. Choose a passkey registered with this site.' });
  }
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response, expectedChallenge: challenge, expectedOrigin: c.env.APP_ORIGIN, expectedRPID: c.env.RP_ID,
      requireUserVerification: true,
      credential: {
        id: credential.id, publicKey: decodeBytes(credential.public_key), counter: credential.counter,
      },
    });
  } catch (error) {
    console.warn(JSON.stringify({ event: 'passkey_authentication_rejected', requestId: c.get('requestId'), error: error instanceof Error ? error.name : 'unknown' }));
    throw new HTTPException(400, { message: 'Passkey verification failed. Start again.' });
  }
  if (!verification.verified) throw new HTTPException(400, { message: 'Passkey verification failed.' });
  const updated = await c.env.DB.prepare(
    'UPDATE passkeys SET counter = ?, backed_up = ? WHERE id = ? AND counter = ? RETURNING user_id',
  ).bind(verification.authenticationInfo.newCounter, Number(verification.authenticationInfo.credentialBackedUp),
    credential.id, credential.counter).first<{ user_id: string }>();
  if (!updated) throw new HTTPException(409, { message: 'The credential changed during authentication. Start again.' });
  await issueSession(c, updated.user_id);
  return c.json({ authenticated: true });
});

auth.post('/passkeys/options', async (c) => {
  requireCommunityEnabled(c);
  const session = requireSession(c, { fresh: true, currentConsent: true });
  const keys = await c.env.DB.prepare('SELECT id FROM passkeys WHERE user_id = ?').bind(session.user_id).all<{ id: string }>();
  if (keys.results.length >= 5) throw new HTTPException(409, { message: 'This account already has the maximum of five passkeys.' });
  const options = await registrationOptions(c, session.user_id, session.handle, keys.results);
  await saveChallenge(c, 'add-passkey', options.challenge, { userId: session.user_id, sessionHash: session.token_hash });
  return c.json(options);
});

auth.post('/passkeys/verify', async (c) => {
  requireCommunityEnabled(c);
  const session = requireSession(c, { fresh: true, currentConsent: true });
  const { challenge, payload } = await consumeChallenge(c, 'add-passkey');
  if (payload.userId !== session.user_id || payload.sessionHash !== session.token_hash) {
    throw new HTTPException(403, { message: 'Passkey enrollment is not bound to this authenticated session.' });
  }
  const verification = await verifyRegistration(c, challenge);
  const results = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM auth_challenges WHERE kind = ? AND json_extract(payload, \'$.userId\') = ?')
      .bind('add-passkey', session.user_id),
    passkeyInsert(c, session.user_id, verification),
  ]);
  if (results[1]?.meta.changes !== 1) throw new HTTPException(409, { message: 'The account already has the maximum of five passkeys.' });
  return c.json({ added: true }, 201);
});

auth.delete('/passkeys/:id', async (c) => {
  const session = requireSession(c, { fresh: true });
  const available: SocialProviderId[] = configuredSocialProviders(c.env).map((entry) => entry.id);
  const result = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ? AND ((SELECT COUNT(*) FROM passkeys WHERE user_id = ?) + (SELECT COUNT(*) FROM social_identities WHERE user_id = ? AND provider IN (SELECT value FROM json_each(?)))) > 1 RETURNING id')
      .bind(c.req.param('id'), session.user_id, session.user_id, session.user_id, JSON.stringify(available)),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ? AND changes() = 1')
      .bind(session.user_id, session.token_hash),
  ]);
  if (result[0]?.meta.changes !== 1) throw new HTTPException(409, { message: 'Passkey not found, not owned by you, or it is your last available sign-in method. Add another method first.' });
  await cancelAuthFlows(c);
  return c.json({ removed: true });
});

auth.post('/logout', async (c) => {
  const session = requireSession(c);
  await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(session.token_hash).run();
  clearAuthCookie(c, 'session');
  clearAuthCookie(c, 'flow');
  await cancelAuthFlows(c);
  return c.json({ signedOut: true });
});
