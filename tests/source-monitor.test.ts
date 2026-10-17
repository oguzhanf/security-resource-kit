import { describe, expect, it } from 'vitest';
import { readBoundedText } from '../server/source-monitor';

describe('upstream content boundaries', () => {
  it('reads valid source content within its exact byte limit', async () => {
    expect(await readBoundedText(new Response('documentation'), 13)).toBe('documentation');
  });

  it('rejects oversized and empty-body responses rather than calling them unchanged', async () => {
    await expect(readBoundedText(new Response('documentation'), 12)).rejects.toThrow('size limit');
    await expect(readBoundedText(new Response(null), 12)).rejects.toThrow('no body');
  });

  it('rejects malformed UTF-8 instead of silently substituting text', async () => {
    await expect(readBoundedText(new Response(new Uint8Array([0xc3, 0x28])), 2)).rejects.toThrow();
  });
});
