export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

export interface SignedUpload {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
}

/**
 * Private object storage for drawing uploads (bucket `drawings`, objects under
 * `{orgId}/…`). The Supabase implementation is the only place the service-role
 * key is used (SEC-08), with a closed set of operations.
 */
export interface ObjectStorage {
  createSignedUpload(path: string, opts: { expiresInSec: number; maxBytes: number }): Promise<SignedUpload>;
  /** Streams an object, or returns null when it does not exist. */
  openRead(path: string): Promise<AsyncIterable<Uint8Array> | null>;
  remove(path: string): Promise<void>;
}

/** Defense in depth: only server-generated `{uuid}/upload/{uuid}` paths are ever touched. */
export function assertSafePath(path: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/upload\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(path)) {
    throw new Error('unsafe storage path');
  }
}
