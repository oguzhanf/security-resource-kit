import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import media from '../shared/training-media.json' with { type: 'json' };

const destination = fileURLToPath(new URL('../public/training-media/', import.meta.url));
await mkdir(destination, { recursive: true });
for (const asset of media) {
  const url = new URL(asset.sourceUrl);
  if (url.origin !== 'https://learn.microsoft.com' || !/^\/en-us\/(?:defender-xdr|azure\/sentinel)\/media\//u.test(url.pathname) ||
    !/^[a-z0-9-]+\.png$/u.test(asset.file)) {
    throw new Error('Screenshot preparation accepts only reviewed Microsoft documentation media and safe filenames.');
  }
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
  if (!response.ok || response.status >= 300 || !response.headers.get('content-type')?.startsWith('image/')) {
    throw new Error(`Documentation screenshot unavailable: ${asset.file}`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 8 * 1024 * 1024) throw new Error('Documentation screenshot exceeds 8 MiB.');
    chunks.push(chunk);
  }
  const original = Buffer.concat(chunks);
  if (createHash('sha256').update(original).digest('hex') !== asset.sourceSha256) {
    throw new Error(`Screenshot upstream changed: ${asset.file}. Review privacy again before approving new source bytes.`);
  }
  const cropped = await sharp(original).extract(asset.crop).png().toBuffer();
  const masks = await Promise.all(asset.masks.map(async (mask) => ({
    input: await sharp({ create: { width: mask.width, height: mask.height, channels: 3, background: '#222222' } }).png().toBuffer(),
    left: mask.left, top: mask.top,
  })));
  // Crop/mask decoded pixels and re-encode: do not publish raw originals or original metadata.
  const output = await sharp(cropped).composite(masks).png().toBuffer();
  if (createHash('sha256').update(output).digest('hex') !== asset.outputSha256) {
    throw new Error(`Redacted screenshot output changed: ${asset.file}. Visually review before updating the approved fingerprint.`);
  }
  await writeFile(new URL(`../public/training-media/${asset.file}`, import.meta.url), output);
  console.log(`Prepared ${asset.file}; visually review the output before deployment.`);
}
