import { ARTIFACT_PATH_RE, SIMILAR_THUMB_PATH_RE } from '@kamutan/contracts';
import type { App } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';

export const URL_SIGNER = Symbol('URL_SIGNER');

export interface SignedUrl {
  url: string;
  expiresAt: Date;
}

/**
 * Issues short-lived read URLs for worker artifacts (tiles, thumbnail, crops). Only sheet-version artifact paths and
 * (Sprint 4) find_similar candidate crops can be signed.
 */
export interface UrlSigner {
  signRead(paths: readonly string[]): Promise<Map<string, SignedUrl>>;
}

export function assertArtifactPath(path: string): void {
  if (!ARTIFACT_PATH_RE.test(path) && !SIMILAR_THUMB_PATH_RE.test(path)) throw new Error('refusing to sign a non-artifact path');
}

async function pool<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Storage V4 signed URLs (firebase-admin → @google-cloud/storage `getSignedUrl`). In Cloud Functions with
 * ADC there is no private key, so every signature is an IAM `signBlob` call: the runtime service account
 * needs roles/iam.serviceAccountTokenCreator on itself. Hence the batch cap and the cache below.
 */
export class FirebaseUrlSigner implements UrlSigner {
  constructor(
    private readonly app: App,
    private readonly bucketName: string,
    private readonly ttlSeconds: number,
    private readonly concurrency = 16,
  ) {}

  async signRead(paths: readonly string[]): Promise<Map<string, SignedUrl>> {
    paths.forEach(assertArtifactPath);
    const bucket = getStorage(this.app).bucket(this.bucketName);
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000);
    const urls = await pool(paths, this.concurrency, async (p) => {
      const [url] = await bucket.file(p).getSignedUrl({ version: 'v4', action: 'read', expires: expiresAt });
      return url;
    });
    return new Map(paths.map((p, i) => [p, { url: urls[i] as string, expiresAt }]));
  }
}

/** Deterministic fake for tests and offline dev (STORAGE_DRIVER=memory). Counts signatures. */
export class FakeUrlSigner implements UrlSigner {
  signed = 0;

  constructor(
    private readonly bucketName = 'test-bucket',
    private readonly ttlSeconds = 900,
    private readonly now: () => number = Date.now,
  ) {}

  async signRead(paths: readonly string[]): Promise<Map<string, SignedUrl>> {
    paths.forEach(assertArtifactPath);
    const expiresAt = new Date(this.now() + this.ttlSeconds * 1000);
    this.signed += paths.length;
    return new Map(
      paths.map((p) => [
        p,
        { url: `https://storage.invalid/${this.bucketName}/${encodeURI(p)}?X-Goog-Expires=${this.ttlSeconds}&X-Fake-Exp=${expiresAt.getTime()}`, expiresAt },
      ]),
    );
  }
}

/**
 * Per-instance cache: a URL is reused while it still has at least `minRemainingMs` of validity, so
 * panning back and forth over the same tiles does not re-sign them. Bounded (oldest entries evicted).
 */
export class CachingUrlSigner implements UrlSigner {
  private readonly cache = new Map<string, SignedUrl>();

  constructor(
    private readonly inner: UrlSigner,
    private readonly minRemainingMs: number,
    private readonly maxEntries = 20_000,
    private readonly now: () => number = Date.now,
  ) {}

  async signRead(paths: readonly string[]): Promise<Map<string, SignedUrl>> {
    paths.forEach(assertArtifactPath);
    const out = new Map<string, SignedUrl>();
    const missing: string[] = [];
    const t = this.now();
    for (const p of new Set(paths)) {
      const hit = this.cache.get(p);
      if (hit && hit.expiresAt.getTime() - t >= this.minRemainingMs) out.set(p, hit);
      else missing.push(p);
    }
    if (missing.length) {
      const fresh = await this.inner.signRead(missing);
      for (const [p, u] of fresh) {
        out.set(p, u);
        this.cache.delete(p);
        this.cache.set(p, u);
      }
      while (this.cache.size > this.maxEntries) {
        const oldest = this.cache.keys().next().value as string;
        this.cache.delete(oldest);
      }
    }
    return out;
  }
}
