import { describe, expect, it } from 'vitest';
import { cookieName, decodeBytes, encodeBytes, getPublicSiteConfig, getSiteConfig, isLocal, randomToken, sameToken, sha256 } from '../server/security';
import type { SiteEnv } from '../server/types';

function production(overrides: Partial<SiteEnv> = {}): SiteEnv {
  return {
    ENVIRONMENT: 'production',
    APP_ORIGIN: 'https://security.example.test',
    RP_ID: 'security.example.test',
    LEGAL_APPROVED: 'true',
    OPERATOR_NAME: 'Test operator',
    CONTACT_URL: 'https://contact.example.test/private',
    TURNSTILE_SITE_KEY: 'test-only-site-key',
    TURNSTILE_SECRET_KEY: 'test-only-not-a-real-secret',
    RATE_LIMIT_SALT: 'test-only-dummy-salt-not-for-production',
    ...overrides,
  };
}

describe('production registration gates', () => {
  it('keeps launch diagnostics out of visitor configuration', () => {
    const env = production({ LEGAL_APPROVED: 'false', CONTACT_URL: '', TURNSTILE_SECRET_KEY: undefined });
    expect(getSiteConfig(env).setupRequired.length).toBeGreaterThan(0);
    const visitor = getPublicSiteConfig(env);
    expect(visitor.registrationEnabled).toBe(false);
    expect(Object.hasOwn(visitor, 'setupRequired')).toBe(false);
    expect(JSON.stringify(visitor)).not.toContain('must review');
    expect(JSON.stringify(visitor)).not.toContain('Configure');
  });
  it('requires approved policies, operator contact, secure origin, bot controls, and a salt', () => {
    expect(getSiteConfig(production()).registrationEnabled).toBe(true);
    for (const change of [
      { LEGAL_APPROVED: 'false' }, { OPERATOR_NAME: '' }, { CONTACT_URL: '' },
      { CONTACT_URL: 'javascript:alert(1)' }, { CONTACT_URL: 'https://user:password@contact.example.test' },
      { TURNSTILE_SITE_KEY: '' }, { TURNSTILE_SECRET_KEY: undefined }, { RATE_LIMIT_SALT: undefined },
      { RATE_LIMIT_SALT: 'too-short' }, { RATE_LIMIT_SALT: 'local-development-only-not-for-production' },
      { APP_ORIGIN: 'http://security.example.test' }, { RP_ID: 'other.example.test' },
      { APP_ORIGIN: 'https://configure-before-deploy.invalid', RP_ID: 'configure-before-deploy.invalid' },
      { APP_ORIGIN: 'https://security.example.test/unexpected-path' },
    ]) {
      const result = getSiteConfig(production(change));
      expect(result.registrationEnabled, JSON.stringify(change)).toBe(false);
      expect(result.setupRequired.length).toBeGreaterThan(0);
    }
  });

  it('never allows an environment-name change alone to bypass production controls', () => {
    const env = production({ ENVIRONMENT: 'local', TURNSTILE_SECRET_KEY: undefined, LEGAL_APPROVED: 'false' });
    expect(isLocal(env)).toBe(false);
    expect(getSiteConfig(env).registrationEnabled).toBe(false);
    expect(cookieName(env, 'session')).toBe('__Host-srk-session');
  });

  it('restricts the development exception to the exact loopback origin and RP ID', () => {
    const env = production({ ENVIRONMENT: 'local', APP_ORIGIN: 'http://localhost:8787', RP_ID: 'localhost' });
    expect(isLocal(env)).toBe(true);
    expect(cookieName(env, 'flow')).toBe('srk-flow');
    expect(isLocal({ ...env, APP_ORIGIN: 'http://0.0.0.0:8787' })).toBe(false);
    expect(isLocal({ ...env, APP_ORIGIN: 'https://localhost.attacker.test:8787' })).toBe(false);
  });
});

describe('session primitives', () => {
  it('generates unique 256-bit opaque tokens, not identities or passwords', () => {
    const tokens = Array.from({ length: 100 }, randomToken);
    expect(new Set(tokens).size).toBe(100);
    expect(tokens.every((token) => /^[a-f0-9]{64}$/u.test(token))).toBe(true);
  });

  it('hashes tokens before persistent storage and compares only valid tokens', async () => {
    const token = randomToken();
    const digest = await sha256(token);
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(digest).not.toBe(token);
    expect(sameToken(token, token)).toBe(true);
    expect(sameToken(token, randomToken())).toBe(false);
    expect(sameToken('', '')).toBe(false);
    expect(sameToken(token, `${token}x`)).toBe(false);
  });

  it('round-trips public key bytes with canonical base64url encoding', () => {
    const bytes = new Uint8Array([0, 1, 128, 254, 255]);
    const encoded = encodeBytes(bytes);
    expect(encoded).not.toMatch(/[+/=]/u);
    expect(decodeBytes(encoded)).toEqual(bytes);
  });
});
