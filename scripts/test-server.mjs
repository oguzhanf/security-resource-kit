import { spawn } from 'node:child_process';
import { root, runWrangler, testState, wranglerBin } from './wrangler.mjs';

runWrangler(['d1', 'migrations', 'apply', 'security-resource-kit-local', '--env', 'local', '--local', '--persist-to', testState]);
runWrangler([
  'd1', 'execute', 'security-resource-kit-local', '--env', 'local', '--local', '--persist-to', testState,
  '--command', 'DELETE FROM users; DELETE FROM discussion_threads; DELETE FROM auth_challenges; DELETE FROM oauth_flows; DELETE FROM rate_limits; DELETE FROM moderation_audit; DELETE FROM source_checks; DELETE FROM contact_requests; DELETE FROM lesson_content; DELETE FROM lesson_content_history;',
]);
const child = spawn(process.execPath, [
  wranglerBin, 'dev', '--env', 'local', '--ip', '127.0.0.1', '--port', '8787',
  '--persist-to', testState, '--test-scheduled', '--show-interactive-dev-session', 'false',
  '--var', 'GITHUB_CLIENT_ID:test-only-github-client',
  '--var', 'GITHUB_CLIENT_SECRET:test-only-github-secret',
  '--var', 'MICROSOFT_CLIENT_ID:11111111-2222-4333-8444-555555555555',
  '--var', 'MICROSOFT_CLIENT_SECRET:test-only-microsoft-secret',
], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
  windowsHide: true,
});
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exit(code ?? 1); });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
