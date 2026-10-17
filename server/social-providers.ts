import { createRemoteJWKSet, customFetch, decodeJwt, errors, jwtVerify } from 'jose';
import { z } from 'zod';
import { SOCIAL_PROVIDERS } from '../shared/contracts';
import type { SocialProviderId } from '../shared/contracts';
import { BoundedResponseError, readBoundedText } from './http';
import type { SiteEnv } from './types';

const microsoftKeysUrl = 'https://login.microsoftonline.com/common/discovery/v2.0/keys';
const microsoftIssuerTemplate = 'https://login.microsoftonline.com/{tenantid}/v2.0';

export class SocialProviderError extends Error {
  constructor(public readonly reason: 'unavailable' | 'invalid-identity') {
    super(reason === 'unavailable' ? 'The identity provider is temporarily unavailable.' : 'The provider identity could not be verified.');
    this.name = 'SocialProviderError';
  }
}

export function configuredSocialProviders(env: SiteEnv) {
  return SOCIAL_PROVIDERS.filter(({ id }) => id === 'microsoft'
    ? !!env.MICROSOFT_CLIENT_ID?.trim() && !!env.MICROSOFT_CLIENT_SECRET?.trim()
    : !!env.GITHUB_CLIENT_ID?.trim() && !!env.GITHUB_CLIENT_SECRET?.trim());
}

export function socialCredentials(env: SiteEnv, provider: SocialProviderId) {
  const clientId = provider === 'microsoft' ? env.MICROSOFT_CLIENT_ID?.trim() : env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = provider === 'microsoft' ? env.MICROSOFT_CLIENT_SECRET : env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret?.trim()) throw new SocialProviderError('unavailable');
  return { clientId, clientSecret };
}

export function socialCallbackUrl(env: SiteEnv, provider: SocialProviderId): string {
  return new URL(`/api/auth/social/${provider}/callback`, env.APP_ORIGIN).href;
}

async function providerFetch(url: string, options: RequestInit, limit = 65536): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, { ...options, redirect: 'manual', signal: options.signal || AbortSignal.timeout(8000) });
    if (!response.ok || !/^application\/(?:json|[^;]+\+json)(?:\s*;|$)/iu.test(response.headers.get('content-type') || '')) {
      throw new SocialProviderError('unavailable');
    }
    return await readBoundedText(response, limit);
  } catch (error) {
    if (error instanceof TypeError || error instanceof DOMException || error instanceof BoundedResponseError) {
      throw new SocialProviderError('unavailable');
    }
    throw error;
  }
}

async function providerJson<T>(url: string, options: RequestInit, schema: z.ZodType<T>): Promise<T> {
  const text = await providerFetch(url, options);
  let data: unknown;
  try { data = JSON.parse(text); }
  catch (error) {
    if (error instanceof SyntaxError) throw new SocialProviderError('invalid-identity');
    throw error;
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new SocialProviderError('invalid-identity');
  return parsed.data;
}

const microsoftKeys = createRemoteJWKSet(new URL(microsoftKeysUrl), {
  timeoutDuration: 8000,
  [customFetch]: async (url, options) => {
    if (url !== microsoftKeysUrl) throw new SocialProviderError('invalid-identity');
    const text = await providerFetch(url, options, 262144);
    return new Response(text, { headers: { 'Content-Type': 'application/json' } });
  },
});

export type VerifiedSocialIdentity =
  | { provider: 'github'; issuer: 'https://github.com'; subject: string }
  | { provider: 'microsoft'; issuer: string; subject: string; nonce: string };

export async function verifyMicrosoftIdentity(token: string, clientId: string): Promise<VerifiedSocialIdentity & { provider: 'microsoft' }> {
  try {
    const tenant = z.guid().parse(decodeJwt(token).tid).toLowerCase();
    const issuer = microsoftIssuerTemplate.replace('{tenantid}', tenant);
    const result = await jwtVerify(token, microsoftKeys, {
      algorithms: ['RS256'], audience: clientId, issuer,
      requiredClaims: ['exp', 'iat', 'nbf', 'sub', 'tid', 'nonce'],
      maxTokenAge: 600, clockTolerance: 5,
    });
    const claims = z.object({
      sub: z.string().min(1).max(255),
      nonce: z.string().regex(/^[a-f0-9]{64}$/u),
      tid: z.guid(),
      ver: z.literal('2.0'),
    }).parse(result.payload);
    const kid = z.string().min(1).max(200).parse(result.protectedHeader.kid);
    const candidates = microsoftKeys.jwks()?.keys.filter((key) => key.kid === kid &&
      key.kty === 'RSA' && key.use === 'sig' && (!key.alg || key.alg === 'RS256'));
    const metadata = z.object({ issuer: z.string() }).safeParse(candidates?.length === 1 ? candidates[0] : null);
    if (!metadata.success || metadata.data.issuer.replace('{tenantid}', tenant) !== issuer || claims.tid.toLowerCase() !== tenant) {
      throw new SocialProviderError('invalid-identity');
    }
    return { provider: 'microsoft', issuer, subject: claims.sub, nonce: claims.nonce };
  } catch (error) {
    if (error instanceof errors.JOSEError || error instanceof z.ZodError || error instanceof TypeError) {
      throw new SocialProviderError('invalid-identity');
    }
    throw error;
  }
}

export async function exchangeSocialCode(
  env: SiteEnv, provider: SocialProviderId, code: string, verifier: string,
): Promise<VerifiedSocialIdentity> {
  const { clientId, clientSecret } = socialCredentials(env, provider);
  const body = new URLSearchParams({
    client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier,
    redirect_uri: socialCallbackUrl(env, provider),
  });
  if (provider === 'microsoft') {
    body.set('grant_type', 'authorization_code');
    body.set('scope', 'openid profile');
    const result = await providerJson('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    }, z.object({ id_token: z.string().min(100).max(24000), token_type: z.string().toLowerCase().pipe(z.literal('bearer')) }));
    return verifyMicrosoftIdentity(result.id_token, clientId);
  }
  const result = await providerJson('https://github.com/login/oauth/access_token', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  }, z.object({
    access_token: z.string().min(20).max(8192),
    token_type: z.string().toLowerCase().pipe(z.literal('bearer')),
    scope: z.string().max(2048),
  }));
  if (result.scope.trim()) throw new SocialProviderError('invalid-identity');
  const user = await providerJson('https://api.github.com/user', {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${result.access_token}`, 'User-Agent': 'Security-Resource-Kit' },
  }, z.object({ id: z.number().int().positive().safe(), type: z.literal('User') }));
  return { provider: 'github', issuer: 'https://github.com', subject: String(user.id) };
}
