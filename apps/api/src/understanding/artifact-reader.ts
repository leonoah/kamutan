import { gunzipSync, gzipSync } from 'node:zlib';
import { UNDERSTANDING_ARTIFACT_PATH_RE } from '@kamutan/contracts';
import type { App } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';

export const ARTIFACT_READER = Symbol('ARTIFACT_READER');

/** Compressed / decompressed size caps for a worker artifact read by the API (zip-bomb guard). */
export const MAX_ARTIFACT_GZ_BYTES = 16 * 1024 * 1024;
export const MAX_ARTIFACT_JSON_BYTES = 96 * 1024 * 1024;

/**
 * Server-side read of the Sprint-2 understanding artifacts (legend/detections/rooms .json.gz). Only those three
 * object names under a sheet-version prefix can be read; the caller derives the path from authorized ids.
 * Returns the parsed JSON (untrusted, worker-written — validate before use) or null when the object is missing.
 */
export interface ArtifactReader {
  readJson(path: string): Promise<unknown | null>;
}

export class ArtifactTooLargeError extends Error {}

export function assertUnderstandingArtifactPath(path: string): void {
  if (!UNDERSTANDING_ARTIFACT_PATH_RE.test(path)) throw new Error('refusing to read a non-understanding artifact path');
}

export function decodeGzipJson(buf: Buffer): unknown {
  if (buf.length > MAX_ARTIFACT_GZ_BYTES) throw new ArtifactTooLargeError('artifact too large');
  let raw: Buffer;
  try {
    raw = gunzipSync(buf, { maxOutputLength: MAX_ARTIFACT_JSON_BYTES });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new ArtifactTooLargeError('artifact too large');
    throw err;
  }
  return JSON.parse(raw.toString('utf8')) as unknown;
}

export class FirebaseArtifactReader implements ArtifactReader {
  constructor(
    private readonly app: App,
    private readonly bucketName: string,
  ) {}

  async readJson(path: string): Promise<unknown | null> {
    assertUnderstandingArtifactPath(path);
    const file = getStorage(this.app).bucket(this.bucketName).file(path);
    try {
      const [meta] = await file.getMetadata();
      if (Number(meta.size ?? 0) > MAX_ARTIFACT_GZ_BYTES) throw new ArtifactTooLargeError('artifact too large');
      // decompress: false → we always get the stored gzip bytes, whatever Content-Encoding the worker set.
      const [buf] = await file.download({ decompress: false, validation: false });
      return decodeGzipJson(buf);
    } catch (err) {
      if ((err as { code?: number }).code === 404) return null;
      throw err;
    }
  }
}

/** In-memory bucket for tests / offline dev (STORAGE_DRIVER=memory). */
export class InMemoryArtifactReader implements ArtifactReader {
  readonly objects = new Map<string, Buffer>();
  reads = 0;

  /** Test helper: stores `value` as gzip JSON (what the worker uploads). */
  putJson(path: string, value: unknown): void {
    assertUnderstandingArtifactPath(path);
    this.objects.set(path, gzipSync(Buffer.from(JSON.stringify(value))));
  }

  async readJson(path: string): Promise<unknown | null> {
    assertUnderstandingArtifactPath(path);
    this.reads++;
    const buf = this.objects.get(path);
    return buf ? decodeGzipJson(buf) : null;
  }
}
