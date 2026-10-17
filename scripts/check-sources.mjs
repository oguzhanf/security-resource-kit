import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const registryUrl = new URL('../shared/source-registry.json', import.meta.url);
const baselinesUrl = new URL('../shared/source-baselines.json', import.meta.url);
const registry = JSON.parse(await readFile(registryUrl, 'utf8'));
const allowedSources = JSON.parse(await readFile(new URL('../shared/source-allowlist.json', import.meta.url), 'utf8'));
const baselines = JSON.parse(await readFile(baselinesUrl, 'utf8'));
const approve = process.argv.includes('--approve');
const selected = process.argv.filter((argument) => !argument.startsWith('--')).slice(2);
if (selected.some((id) => !registry.some((source) => source.id === id))) {
  throw new Error('Unknown source ID. Use an ID from shared/source-registry.json.');
}
if (approve && selected.length === 0) {
  throw new Error('Approval requires explicit source IDs after a technical review; for example: npm run sources:approve -- identities.');
}

const results = await Promise.all(registry.filter((source) => selected.length === 0 || selected.includes(source.id)).map(async (source) => {
  const url = new URL(source.upstream);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
    !allowedSources.some((rule) => url.hostname === rule.host && url.pathname.startsWith(rule.pathPrefix))) {
    throw new Error(`Unapproved source host or path for ${source.id}.`);
  }
  const response = await fetch(url.href, { signal: AbortSignal.timeout(20000), redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) throw new Error(`${source.id}: upstream redirects are not permitted.`);
  if (!response.ok) throw new Error(`${source.id}: upstream returned HTTP ${response.status}.`);
  const text = (await response.text()).replace(/\r\n/gu, '\n').trim();
  if (text.length < 100 || text.length > 500000) throw new Error(`${source.id}: unexpected source size.`);
  const hash = createHash('sha256').update(text).digest('hex');
  const status = baselines[source.id]?.sha256 === hash ? 'unchanged' : 'review-required';
  if (approve) baselines[source.id] = { sha256: hash, approvedAt: new Date().toISOString().slice(0, 10) };
  return { sourceId: source.id, status: approve ? 'approved' : status };
}));

if (approve) await writeFile(baselinesUrl, `${JSON.stringify(baselines, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(results, null, 2));
if (!approve && results.some((result) => result.status !== 'unchanged')) process.exitCode = 1;
