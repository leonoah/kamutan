import { PROJECT_UPLOAD_PATH_RE, QUARANTINE_PATH_RE } from '@kamutan/contracts';

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

/**
 * Admin access to the default bucket (kamutan-fba67.firebasestorage.app).
 * Only server-generated paths of the ADR 0008 layout are ever touched:
 * reads from `orgs/{orgId}/quarantine/{uuid}`, writes to
 * `orgs/{orgId}/projects/{projectId}/uploads/{sheetSetId}/source.{ext}`.
 */
export interface ObjectStorage {
  /** Streams a quarantined object, or null when it does not exist. */
  openRead(path: string): Promise<AsyncIterable<Uint8Array> | null>;
  /** Server-side move quarantine → project upload (copy + delete). Overwrites (destination is content-addressed). */
  move(src: string, dest: string, meta: { contentType: string; metadata: Record<string, string> }): Promise<void>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
}

export function assertQuarantinePath(path: string): void {
  if (!QUARANTINE_PATH_RE.test(path)) throw new Error('unsafe quarantine path');
}

export function assertProjectUploadPath(path: string): void {
  if (!PROJECT_UPLOAD_PATH_RE.test(path)) throw new Error('unsafe upload path');
}

export function assertKnownPath(path: string): void {
  if (!QUARANTINE_PATH_RE.test(path) && !PROJECT_UPLOAD_PATH_RE.test(path)) throw new Error('unsafe storage path');
}
