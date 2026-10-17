import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPublicApiRequest, MEMBER_ASSET_ROUTES, PUBLIC_PAGE_IDS, WORKER_FIRST_ROUTES } from '../shared/access-policy';

describe('default-deny content policy', () => {
  it('allows only the landing page and required registration policies publicly', () => {
    expect([...PUBLIC_PAGE_IDS].sort()).toEqual(['contact', 'home', 'privacy', 'terms']);
  });

  it('does not classify content or future endpoints as public', () => {
    for (const path of ['/api/catalog', '/api/sources', '/api/discussions/home', '/api/forums', '/api/forums/site', '/api/threads/page-home', '/api/comments/test/replies', '/api/progress', '/api/account', '/api/new-content']) {
      expect(isPublicApiRequest('GET', path)).toBe(false);
    }
    expect(isPublicApiRequest('GET', '/api/outline')).toBe(true);
    expect(isPublicApiRequest('POST', '/api/outline')).toBe(false);
    expect(isPublicApiRequest('GET', '/api/auth/register/options')).toBe(false);
    expect(isPublicApiRequest('POST', '/api/contact')).toBe(true);
    expect(isPublicApiRequest('GET', '/api/contact')).toBe(false);
    expect(isPublicApiRequest('GET', '/api/moderation/contacts')).toBe(false);
    for (const provider of ['microsoft', 'github']) {
      expect(isPublicApiRequest('POST', `/api/auth/social/${provider}/start`)).toBe(true);
      expect(isPublicApiRequest('GET', `/api/auth/social/${provider}/callback`)).toBe(true);
      expect(isPublicApiRequest('GET', `/api/auth/social/${provider}/start`)).toBe(false);
      expect(isPublicApiRequest('POST', `/api/auth/social/${provider}/callback`)).toBe(false);
      expect(isPublicApiRequest('DELETE', `/api/auth/social/${provider}`)).toBe(false);
    }
    expect(isPublicApiRequest('GET', '/api/auth/social/unknown/callback')).toBe(false);
  });

  it('runs member page navigation through the Worker', () => {
    expect(MEMBER_ASSET_ROUTES).toEqual(['/learn/*', '/tracks/*', '/about', '/sources', '/roadmap', '/account', '/management', '/management/*', '/discussions', '/discussions/*', '/training-media/*']);
    const config = readFileSync(join(process.cwd(), 'wrangler.toml'), 'utf8');
    const lists = [...config.matchAll(/^run_worker_first = (\[.+\])$/gmu)];
    expect(lists).toHaveLength(2);
    for (const match of lists) expect(JSON.parse(match[1] || '[]')).toEqual(WORKER_FIRST_ROUTES);
    const generator = readFileSync(join(process.cwd(), 'scripts', 'cloud-setup.mjs'), 'utf8');
    const generated = /run_worker_first: (\[.+\])/u.exec(generator)?.[1];
    expect(JSON.parse((generated || '[]').replaceAll("'", '"'))).toEqual(WORKER_FIRST_ROUTES);
  });
});
