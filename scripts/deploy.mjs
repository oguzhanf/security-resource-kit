import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { productionConfig, runWrangler } from './wrangler.mjs';

let config;
try {
  config = JSON.parse(await readFile(productionConfig, 'utf8'));
} catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
    throw new Error('Run npm run cloud:setup after authorizing your Cloudflare account. Temporary accounts and local hosting are not deployment targets.', { cause: error });
  }
  throw error;
}
if (config.vars?.ENVIRONMENT !== 'production' || !String(config.name).startsWith('security-resource-kit')) {
  throw new Error('Only this project\'s production cloud config can be deployed.');
}
if (['TURNSTILE_SECRET_KEY', 'RATE_LIMIT_SALT', 'MICROSOFT_CLIENT_SECRET', 'GITHUB_CLIENT_SECRET'].some((key) => Object.hasOwn(config.vars, key))) {
  throw new Error('Secrets must be Worker secrets, not variables in a config file.');
}
const database = config.d1_databases?.find((binding) => binding.binding === 'DB');
z.uuid().refine((id) => id !== '00000000-0000-0000-0000-000000000000').parse(database?.database_id);

runWrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', productionConfig]);
const output = runWrangler(['deploy', '--config', productionConfig], { capture: true });
process.stdout.write(output);
const workerUrl = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\b/iu.exec(output)?.[0];
if (!workerUrl) throw new Error('Deployment output did not include a workers.dev address. Check the Cloudflare deployment before retrying.');

const secrets = z.array(z.object({ name: z.string() })).parse(JSON.parse(runWrangler(['secret', 'list', '--config', productionConfig], { capture: true })));
if (!secrets.some((secret) => secret.name === 'RATE_LIMIT_SALT')) {
  runWrangler(['secret', 'put', 'RATE_LIMIT_SALT', '--config', productionConfig], { input: randomBytes(32).toString('hex') });
}
if (config.vars.APP_ORIGIN.endsWith('.invalid')) {
  config.vars.APP_ORIGIN = workerUrl;
  config.vars.RP_ID = new URL(workerUrl).hostname;
  await writeFile(productionConfig, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  runWrangler(['deploy', '--config', productionConfig]);
}

const target = config.vars.APP_ORIGIN;
let healthy = false;
for (let attempt = 0; attempt < 8; attempt += 1) {
  try {
    const response = await fetch(`${target}/api/health`, { signal: AbortSignal.timeout(10000) });
    const result = z.object({ ok: z.literal(true), service: z.literal('Security Resource Kit') }).safeParse(await response.json());
    if (response.ok && result.success) { healthy = true; break; }
  } catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof DOMException) && !(error instanceof SyntaxError)) throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
}
if (!healthy) throw new Error(`Cloud deployment exists, but its health check failed at ${target}. Do not claim launch success.`);
const launch = z.object({ registrationEnabled: z.boolean(), authProviders: z.array(z.object({ id: z.string() })) })
  .parse(await (await fetch(`${target}/api/config`, { signal: AbortSignal.timeout(10000) })).json());
if (launch.registrationEnabled && launch.authProviders.some((provider) => provider.id === 'github')) {
  const start = await fetch(`${target}/api/auth/social/github/start`, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: { Origin: target, 'Content-Type': 'application/json', 'X-SRK-Request': '1' },
    body: JSON.stringify({ intent: 'login' }),
  });
  if (!start.ok) throw new Error('The deployed GitHub sign-in could not start.');
  const authorization = z.object({ provider: z.literal('github'), authorizationUrl: z.url() }).parse(await start.json());
  const url = new URL(authorization.authorizationUrl);
  if (url.origin !== 'https://github.com' || url.pathname !== '/login/oauth/authorize') {
    throw new Error('The deployed GitHub sign-in returned an unapproved authorization endpoint.');
  }
  const flow = start.headers.getSetCookie().find((cookie) => cookie.startsWith('__Host-srk-oauth=') && !cookie.includes('Max-Age=0'));
  if (!flow || !url.searchParams.get('state')) throw new Error('The deployed GitHub browser binding was not established.');
  let publicStatus;
  let publicFailure;
  try {
    publicStatus = (await fetch(url.href, { redirect: 'manual', signal: AbortSignal.timeout(10000) })).status;
  } catch (error) { publicFailure = error; }
  const cancelled = await fetch(`${target}/api/auth/social/github/callback?state=${encodeURIComponent(url.searchParams.get('state'))}&error=access_denied`, {
    redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { Cookie: flow.split(';')[0] },
  });
  if (cancelled.status !== 303 || cancelled.headers.get('location') !== '/?authError=cancelled') {
    throw new Error('The deployment verification sign-in flow could not be cancelled safely.');
  }
  if (publicFailure) throw publicFailure;
  if (publicStatus !== 200 && publicStatus !== 302) {
    throw new Error(`GitHub public authorization is unavailable (HTTP ${publicStatus}). Use a personal/regular-organization-owned app, not an Enterprise Managed User app.`);
  }
  console.log('GitHub authorization is accessible outside an enterprise-managed session.');
}
console.log(`Verified permanent cloud address: ${target}`);
if (!launch.registrationEnabled) {
  console.log('The public registration landing page is live. Training access requires a registered signed-in account. New account registration remains closed:');
  if (config.vars.LEGAL_APPROVED !== 'true') console.log('- Review and approve the terms/privacy policy in the operator configuration.');
  if (!config.vars.OPERATOR_NAME?.trim() || !config.vars.CONTACT_URL) console.log('- Set the responsible operator and private HTTPS contact channel.');
  if (!config.vars.TURNSTILE_SITE_KEY || !secrets.some((secret) => secret.name === 'TURNSTILE_SECRET_KEY')) console.log('- Set the production Turnstile site key and Worker secret.');
  console.log('Detailed launch configuration is operator-only; it is not returned in the visitor API.');
} else {
  console.log('Public participation is enabled. Register with an available account provider or an optional passkey, then grant a moderator role to the verified account ID.');
}
