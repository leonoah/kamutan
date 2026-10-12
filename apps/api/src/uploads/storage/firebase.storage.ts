import type { App } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { assertKnownPath, assertUploadPath, type ObjectStorage } from './object-storage';

/** Cloud Storage via firebase-admin (ADC). Honours FIREBASE_STORAGE_EMULATOR_HOST. */
export class FirebaseObjectStorage implements ObjectStorage {
  constructor(
    private readonly app: App,
    private readonly bucketName: string,
  ) {}

  private bucket() {
    return getStorage(this.app).bucket(this.bucketName);
  }

  async openRead(path: string): Promise<AsyncIterable<Uint8Array> | null> {
    assertUploadPath(path);
    const file = this.bucket().file(path);
    const [exists] = await file.exists();
    if (!exists) return null;
    return file.createReadStream({ validation: false });
  }

  async copy(src: string, dest: string, meta: { contentType: string; metadata: Record<string, string> }): Promise<void> {
    assertUploadPath(src);
    assertKnownPath(dest);
    const [copied] = await this.bucket().file(src).copy(this.bucket().file(dest));
    await copied.setMetadata({
      contentType: meta.contentType,
      contentDisposition: 'attachment', // never rendered inline (SEC-20)
      cacheControl: 'private, max-age=0, no-store',
      metadata: meta.metadata,
    });
  }

  async exists(path: string): Promise<boolean> {
    assertKnownPath(path);
    const [exists] = await this.bucket().file(path).exists();
    return exists;
  }

  async remove(path: string): Promise<void> {
    assertKnownPath(path);
    await this.bucket().file(path).delete({ ignoreNotFound: true });
  }
}
