import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { productionConfig, runWrangler } from './wrangler.mjs';

const { values } = parseArgs({
  options: {
    origin: { type: 'string' },
    name: { type: 'string' },
    'database-id': { type: 'string' },
    'account-id': { type: 'string' },
    'operator-name': { type: 'string' },
    'contact-url': { type: 'string' },
    'turnstile-site-key': { type: 'string' },
    'legal-approved': { type: 'boolean', default: false },
  },
});

let existing;
try {
  existing = JSON.parse(await readFile(productionConfig, 'utf8'));
} catch (error) {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
}
if (existing && (!String(existing.name).startsWith('security-resource-kit') || existing.vars?.ENVIRONMENT !== 'production')) {
  throw new Error('Existing production config is not recognized as this project. It was not replaced.');
}

const name = values.name || existing?.name || `security-resource-kit-${randomBytes(3).toString('hex')}`;
z.string().regex(/^security-resource-kit(?:-[a-z0-9-]+)?$/u).max(63).parse(name);
const origin = values.origin || existing?.vars?.APP_ORIGIN || 'https://configure-before-deploy.invalid';
const parsedOrigin = new URL(origin);
if (parsedOrigin.protocol !== 'https:' || parsedOrigin.origin !== origin || parsedOrigin.username || parsedOrigin.password) {
  throw new Error('--origin must be an exact HTTPS origin, without a path or credentials.');
}
const contact = values['contact-url'] ?? existing?.vars?.CONTACT_URL ?? '';
if (contact && (!URL.canParse(contact) || new URL(contact).protocol !== 'https:' || new URL(contact).username || new URL(contact).password)) {
  throw new Error('--contact-url must be an HTTPS private contact channel.');
}
const accountId = values['account-id'] || existing?.account_id || process.env.CLOUDFLARE_ACCOUNT_ID;
if (accountId) z.string().regex(/^[a-f0-9]{32}$/u).parse(accountId);
if (accountId) process.env.CLOUDFLARE_ACCOUNT_ID = accountId;

let databaseId = values['database-id'] || existing?.d1_databases?.find((database) => database.binding === 'DB')?.database_id;
const databaseName = `${name}-db`;
if (!databaseId) {
  const databases = z.array(z.object({ name: z.string(), uuid: z.uuid() })).parse(JSON.parse(runWrangler(['d1', 'list', '--json'], { capture: true })));
  if (databases.some((database) => database.name === databaseName)) {
    throw new Error('A database with this name already exists. Supply its --database-id explicitly; existing resources are never adopted silently.');
  }
  runWrangler(['d1', 'create', databaseName, '--update-config', 'false']);
  const created = z.array(z.object({ name: z.string(), uuid: z.uuid() })).parse(JSON.parse(runWrangler(['d1', 'list', '--json'], { capture: true })));
  databaseId = created.find((database) => database.name === databaseName)?.uuid;
  if (!databaseId) throw new Error('The created database was not found. Do not retry provisioning without checking your account.');
}
z.uuid().refine((id) => id !== '00000000-0000-0000-0000-000000000000').parse(databaseId);

const approved = values['legal-approved'] || existing?.vars?.LEGAL_APPROVED === 'true';
const operator = values['operator-name'] ?? existing?.vars?.OPERATOR_NAME ?? '@oguzhanf';
const siteKey = values['turnstile-site-key'] ?? existing?.vars?.TURNSTILE_SITE_KEY ?? '';
if (approved && (!operator.trim() || !contact || !siteKey || parsedOrigin.hostname.endsWith('.invalid'))) {
  throw new Error('Public participation requires a final origin, responsible operator, private contact channel, and Turnstile site key before legal approval is enabled.');
}

const config = {
  name,
  main: 'server/index.ts',
  compatibility_date: '2026-10-03',
  compatibility_flags: ['nodejs_compat'],
  workers_dev: true,
  ...(accountId ? { account_id: accountId } : {}),
  assets: {
    directory: './dist', binding: 'ASSETS',
    not_found_handling: 'single-page-application',
    run_worker_first: ['/api/*', '/learn/*', '/tracks/*', '/about', '/sources', '/roadmap', '/account', '/management', '/management/*', '/discussions', '/discussions/*', '/training-media/*'],
  },
  triggers: { crons: ['17 6 * * *'] },
  vars: {
    ENVIRONMENT: 'production', APP_ORIGIN: origin, RP_ID: parsedOrigin.hostname,
    LEGAL_APPROVED: String(approved), OPERATOR_NAME: operator, CONTACT_URL: contact,
    TURNSTILE_SITE_KEY: siteKey,
  },
  d1_databases: [{
    binding: 'DB', database_name: databaseName, database_id: databaseId, migrations_dir: 'migrations',
  }],
};
await writeFile(productionConfig, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
console.log(`Cloud configuration written for ${name}. Public registration ${approved ? 'requires the configured production secrets' : 'remains closed pending operator approval'}.`);
console.log('Next: npm run deploy. This creates a permanent deployment in your authenticated Cloudflare account, not a temporary preview account.');
