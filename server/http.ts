export class BoundedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoundedResponseError';
  }
}

export async function readBoundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) throw new BoundedResponseError('Upstream response has no body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new BoundedResponseError('Upstream content exceeds the size limit.');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
}
