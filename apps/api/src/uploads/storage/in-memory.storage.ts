import { Readable } from 'node:stream';
import { assertKnownPath, assertProjectUploadPath, assertQuarantinePath, type ObjectStorage } from './object-storage';

export interface StoredObject {
  data: Buffer;
  contentType?: string;
  metadata?: Record<string, string>;
}

/** In-memory bucket for tests / offline dev (STORAGE_DRIVER=memory). */
export class InMemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, StoredObject>();

  /** Test helper standing in for the client's direct (resumable) upload into quarantine. */
  put(path: string, data: Buffer, contentType?: string): void {
    assertQuarantinePath(path);
    this.objects.set(path, { data, contentType });
  }

  async openRead(path: string): Promise<AsyncIterable<Uint8Array> | null> {
    assertQuarantinePath(path);
    const o = this.objects.get(path);
    if (!o) return null;
    // Chunked like a real stream.
    const chunks: Buffer[] = [];
    for (let i = 0; i < o.data.length; i += 64 * 1024) chunks.push(o.data.subarray(i, i + 64 * 1024));
    return Readable.from(chunks);
  }

  async move(src: string, dest: string, meta: { contentType: string; metadata: Record<string, string> }): Promise<void> {
    assertQuarantinePath(src);
    assertProjectUploadPath(dest);
    const o = this.objects.get(src);
    if (!o) throw new Error('source object missing');
    this.objects.set(dest, { data: o.data, contentType: meta.contentType, metadata: meta.metadata });
    this.objects.delete(src);
  }

  async exists(path: string): Promise<boolean> {
    assertKnownPath(path);
    return this.objects.has(path);
  }

  async remove(path: string): Promise<void> {
    assertKnownPath(path);
    this.objects.delete(path);
  }
}
