import { createHash } from 'node:crypto';
import { SNIFF_BYTES } from './magic-bytes';

export class TooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`object exceeds ${limit} bytes`);
  }
}

export interface InspectResult {
  sha256: string;
  size: number;
  head: Uint8Array;
}

/** Streams an object once: sha256, byte count (aborts past `maxBytes`) and the leading bytes for sniffing. */
export async function inspectStream(source: AsyncIterable<Uint8Array>, maxBytes: number): Promise<InspectResult> {
  const hash = createHash('sha256');
  const head = Buffer.alloc(SNIFF_BYTES);
  let headLen = 0;
  let size = 0;
  for await (const chunk of source) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new TooLargeError(maxBytes);
    if (headLen < SNIFF_BYTES) {
      const n = Math.min(SNIFF_BYTES - headLen, chunk.byteLength);
      head.set(chunk.subarray(0, n), headLen);
      headLen += n;
    }
    hash.update(chunk);
  }
  return { sha256: hash.digest('hex'), size, head: head.subarray(0, headLen) };
}
