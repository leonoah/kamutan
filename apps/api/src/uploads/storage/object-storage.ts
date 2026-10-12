import { SOURCE_PATH_RE, UPLOAD_PATH_RE } from '@kamutan/contracts';

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

/**
 * Admin access to the default bucket (kamutan-fba67.firebasestorage.app).
 * Only server-generated paths of the ADR 0008 layout are ever touched.
 */
export interface ObjectStorage {
  /** Streams an object, or null when it does not exist. */
  openRead(path: string): Promise<AsyncIterable<Uint8Array> | null>;
  /** Server-side copy; overwrites (destination is content-addressed). */
  copy(src: string, dest: string, meta: { contentType: string; metadata: Record<string, string> }): Promise<void>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
}

export function assertUploadPath(path: string): void {
  if (!UPLOAD_PATH_RE.test(path)) throw new Error('unsafe upload path');
}

export function assertKnownPath(path: string): void {
  if (!UPLOAD_PATH_RE.test(path) && !SOURCE_PATH_RE.test(path)) throw new Error('unsafe storage path');
}
