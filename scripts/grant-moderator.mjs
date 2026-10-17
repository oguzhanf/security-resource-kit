import { parseArgs } from 'node:util';
import { z } from 'zod';
import { productionConfig, runWrangler } from './wrangler.mjs';

const { values } = parseArgs({
  options: { 'user-id': { type: 'string' }, handle: { type: 'string' } },
});
const userId = z.uuid().parse(values['user-id']);
const handle = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,29}$/u).parse(values.handle);
const result = runWrangler([
  'd1', 'execute', 'DB', '--remote', '--config', productionConfig, '--json', '--command',
  `UPDATE users SET role = 'moderator' WHERE id = '${userId}' AND handle = '${handle}' RETURNING id, handle, role;`,
], { capture: true });
const rows = z.array(z.object({ success: z.literal(true), results: z.array(z.object({ id: z.uuid(), handle: z.string(), role: z.literal('moderator') })) }))
  .parse(JSON.parse(result));
if (rows.flatMap((row) => row.results).length !== 1) {
  throw new Error('No exact account ID/handle match. No moderator was granted. Verify the ID from the intended learner\'s own account export.');
}
console.log('Moderator granted to the exact verified account ID and handle. Sign in again before moderation actions.');
