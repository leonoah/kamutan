import type { getStorage } from 'firebase-admin/storage';
import { assertSafePath, type ObjectStorage, type SignedUpload } from './object-storage';

type Bucket = ReturnType<ReturnType<typeof getStorage>['bucket']>;

/**
 * Firebase (Google Cloud) Storage via the Admin SDK. Objects are private and only
 * reachable through this class. Uploads use short-lived V4 signed URLs, so the
 * server credentials must be able to sign (a service account key or an attached
 * service account with the Token Creator role). The bucket needs a CORS rule that
 * allows PUT from the web origin.
 */
export class FirebaseObjectStorage implements ObjectStorage {
  constructor(private readonly bucket: Bucket) {}

  async createSignedUpload(path: string, opts: { expiresInSec: number; maxBytes: number }): Promise<SignedUpload> {
    assertSafePath(path);
    const [url] = await this.bucket.file(path).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + opts.expiresInSec * 1000,
    });
    return { url, method: 'PUT', headers: {} };
  }

  async openRead(path: string): Promise<AsyncIterable<Uint8Array> | null> {
    assertSafePath(path);
    const file = this.bucket.file(path);
    const [exists] = await file.exists();
    return exists ? file.createReadStream() : null;
  }

  async remove(path: string): Promise<void> {
    assertSafePath(path);
    await this.bucket.file(path).delete({ ignoreNotFound: true });
  }
}
