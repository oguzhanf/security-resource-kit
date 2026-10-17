import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const wranglerBin = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
export const productionConfig = join(root, 'wrangler.production.json');
export const testState = join(root, '.wrangler', 'e2e-state');

export function runWrangler(args, { capture = false, input } = {}) {
  const result = spawnSync(process.execPath, [wranglerBin, ...args], {
    cwd: root,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
    encoding: 'utf8',
    input,
    stdio: capture ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'inherit', 'inherit'],
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture) process.stderr.write(result.stderr || result.stdout || '');
    throw new Error(`Wrangler ${args[0]} failed. Resolve the reported error before continuing.`);
  }
  return result.stdout || '';
}
