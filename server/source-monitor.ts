import { Hono } from 'hono';
import { z } from 'zod';
import { sources } from '../shared/catalog';
import baselineData from '../shared/source-baselines.json' with { type: 'json' };
import allowedSources from '../shared/source-allowlist.json' with { type: 'json' };
import { now, requireSession, sha256 } from './security';
import type { AppEnv, Env } from './types';
import type { SourceStatus } from '../shared/contracts';
import { readBoundedText } from './http';
export { readBoundedText } from './http';

const baselines = z.record(z.string(), z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  approvedAt: z.string(),
})).parse(baselineData);

export async function checkSources(env: Env): Promise<void> {
  const time = now();
  const results = await Promise.all(sources.map(async (source) => {
    const baseline = baselines[source.id];
    if (!baseline) throw new Error(`Missing approved baseline: ${source.id}`);
    let observed: string | null = null;
    let status: 'unchanged' | 'changed' | 'unavailable' = 'unavailable';
    try {
      const upstream = new URL(source.upstream);
      if (upstream.protocol !== 'https:' || upstream.username || upstream.password || upstream.port ||
        !allowedSources.some((rule) => upstream.hostname === rule.host && upstream.pathname.startsWith(rule.pathPrefix))) {
        throw new Error('Source host is not approved.');
      }
      const response = await fetch(upstream.href, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
      if (response.status >= 300 && response.status < 400) throw new Error('Upstream redirects are not permitted.');
      if (!response.ok) throw new Error(`Upstream returned HTTP ${response.status}`);
      const text = (await readBoundedText(response, 500000)).replace(/\r\n/gu, '\n').trim();
      if (text.length < 100) throw new Error('Upstream content is unexpectedly short.');
      observed = await sha256(text);
      status = observed === baseline.sha256 ? 'unchanged' : 'changed';
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'source_check_unavailable', sourceId: source.id,
        error: error instanceof Error ? error.name : 'unknown',
        reason: error instanceof Error ? error.message.slice(0, 200) : 'Unclassified public-source failure',
      }));
    }
    return env.DB.prepare(
      'INSERT INTO source_checks (source_id, observed_hash, baseline_hash, status, checked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET observed_hash = excluded.observed_hash, baseline_hash = excluded.baseline_hash, status = excluded.status, checked_at = excluded.checked_at',
    ).bind(source.id, observed, baseline.sha256, status, time);
  }));
  await env.DB.batch(results);
}

export async function cleanupExpiredData(env: Env): Promise<void> {
  const time = now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_challenges WHERE expires_at <= ?').bind(time),
    env.DB.prepare('DELETE FROM oauth_flows WHERE expires_at <= ?').bind(time),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(time),
    env.DB.prepare('DELETE FROM rate_limits WHERE expires_at <= ?').bind(time),
    env.DB.prepare('DELETE FROM moderation_audit WHERE created_at < ?').bind(time - 90 * 86400),
    env.DB.prepare('DELETE FROM contact_requests WHERE created_at < ?').bind(time - 90 * 86400),
  ]);
}

export const sourceRoutes = new Hono<AppEnv>();

export async function readSourceStatuses(db: D1Database): Promise<SourceStatus[]> {
  const rows = await db.prepare('SELECT source_id, baseline_hash, status, checked_at FROM source_checks')
    .all<{ source_id: string; baseline_hash: string; status: 'unchanged' | 'changed' | 'unavailable'; checked_at: number }>();
  return sources.map((source) => {
    const row = rows.results.find((item) => item.source_id === source.id && item.baseline_hash === baselines[source.id]?.sha256);
    return { sourceId: source.id, status: row?.status || 'not-checked', checkedAt: row?.checked_at || null };
  });
}

sourceRoutes.get('/sources', async (c) => {
  requireSession(c, { currentConsent: true });
  return c.json(await readSourceStatuses(c.env.DB));
});
