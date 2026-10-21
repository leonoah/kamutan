import { Readable, Writable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { MARKED_PDF_PATH_RE, OFFBOARDING_ZIP_PATH_RE, PROJECT_UPLOAD_PATH_RE, SHARE_BOQ_SNAPSHOT_PATH_RE, TILE_PATH_RE } from '@kamutan/contracts';
import { decodeGzipJson, MAX_ARTIFACT_GZ_BYTES, ArtifactTooLargeError } from '../understanding/artifact-reader';
import type { App } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { contentDisposition } from '../boq/boq-storage';
import type { SignedUrl } from '../sheets/url-signer';

export const GOVERNANCE_STORAGE = Symbol('GOVERNANCE_STORAGE');

/** Largest tile the share proxy reads (a 256 px WebP is a few tens of kB). */
export const MAX_TILE_BYTES = 4 * 1024 * 1024;

/**
 * Sprint 5 object access, each operation pinned to ONE path shape (callers derive paths from authorized ids):
 *  - read  …/sheets/{s}/versions/{v}/tiles/{z}/{x}_{y}.webp      (share proxy: watermark + mask, never signed)
 *  - sign  …/projects/{p}/exports/{id}/marked.pdf                 (members 15 min; share viewers 2 min redirect)
 *  - read  …/projects/{p}/uploads/{set}/source.{ext}              (offboarding ZIP only)
 *  - write/sign orgs/{o}/offboarding/{id}.zip                      (24 h)
 *  - delete everything under orgs/{orgId}/                         (purge script only)
 */
export interface GovernanceStorage {
  readTile(path: string): Promise<Buffer | null>;
  objectExists(path: string): Promise<boolean>;
  signMarkedPdf(path: string, fileName: string, ttlSeconds: number): Promise<SignedUrl>;
  openSource(path: string): Promise<Readable | null>;
  /** Writable for the offboarding ZIP (resumable upload); call `end()` and await 'finish'. */
  createZipWriter(path: string): Writable;
  signZip(path: string, fileName: string, ttlSeconds: number): Promise<SignedUrl>;
  /** Deletes every object under `orgs/{orgId}/`; returns the deleted object names. */
  deleteOrgObjects(orgId: string): Promise<string[]>;
  /** F-4: BOQ snapshot of a share link (gzip JSON, written once at creation). */
  writeShareSnapshot(path: string, value: unknown): Promise<void>;
  readShareSnapshot(path: string): Promise<unknown | null>;
}

const assert = (re: RegExp, path: string, what: string) => {
  if (!re.test(path)) throw new Error(`refusing to touch a non-${what} path`);
};
const ORG_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export class FirebaseGovernanceStorage implements GovernanceStorage {
  constructor(
    private readonly app: App,
    private readonly bucketName: string,
  ) {}

  private bucket() {
    return getStorage(this.app).bucket(this.bucketName);
  }

  async readTile(path: string): Promise<Buffer | null> {
    assert(TILE_PATH_RE, path, 'tile');
    try {
      const [buf] = await this.bucket().file(path).download({ validation: false });
      if (buf.length > MAX_TILE_BYTES) throw new Error('tile too large');
      return buf;
    } catch (err) {
      if ((err as { code?: number }).code === 404) return null;
      throw err;
    }
  }

  async objectExists(path: string): Promise<boolean> {
    assert(MARKED_PDF_PATH_RE, path, 'marked pdf');
    const [exists] = await this.bucket().file(path).exists();
    return exists;
  }

  async signMarkedPdf(path: string, fileName: string, ttlSeconds: number): Promise<SignedUrl> {
    assert(MARKED_PDF_PATH_RE, path, 'marked pdf');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const [url] = await this.bucket().file(path).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: expiresAt,
      responseDisposition: contentDisposition(fileName),
      responseType: 'application/pdf',
    });
    return { url, expiresAt };
  }

  async openSource(path: string): Promise<Readable | null> {
    assert(PROJECT_UPLOAD_PATH_RE, path, 'source');
    const file = this.bucket().file(path);
    const [exists] = await file.exists();
    return exists ? file.createReadStream({ validation: false }) : null;
  }

  createZipWriter(path: string): Writable {
    assert(OFFBOARDING_ZIP_PATH_RE, path, 'offboarding zip');
    return this.bucket()
      .file(path)
      .createWriteStream({
        resumable: true,
        contentType: 'application/zip',
        metadata: { contentDisposition: 'attachment', cacheControl: 'private, max-age=0, no-store' },
      });
  }

  async signZip(path: string, fileName: string, ttlSeconds: number): Promise<SignedUrl> {
    assert(OFFBOARDING_ZIP_PATH_RE, path, 'offboarding zip');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const [url] = await this.bucket().file(path).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: expiresAt,
      responseDisposition: contentDisposition(fileName),
      responseType: 'application/zip',
    });
    return { url, expiresAt };
  }

  async writeShareSnapshot(path: string, value: unknown): Promise<void> {
    assert(SHARE_BOQ_SNAPSHOT_PATH_RE, path, 'share snapshot');
    await this.bucket()
      .file(path)
      .save(gzipSync(Buffer.from(JSON.stringify(value))), { resumable: false, contentType: 'application/gzip', metadata: { cacheControl: 'private, max-age=0, no-store' } });
  }

  async readShareSnapshot(path: string): Promise<unknown | null> {
    assert(SHARE_BOQ_SNAPSHOT_PATH_RE, path, 'share snapshot');
    try {
      const file = this.bucket().file(path);
      const [meta] = await file.getMetadata();
      if (Number(meta.size ?? 0) > MAX_ARTIFACT_GZ_BYTES) throw new ArtifactTooLargeError('snapshot too large');
      const [buf] = await file.download({ decompress: false, validation: false });
      return decodeGzipJson(buf);
    } catch (err) {
      if ((err as { code?: number }).code === 404) return null;
      throw err;
    }
  }

  async deleteOrgObjects(orgId: string): Promise<string[]> {
    if (!ORG_ID_RE.test(orgId)) throw new Error('invalid org id');
    const prefix = `orgs/${orgId}/`;
    const names: string[] = [];
    let pageToken: string | undefined;
    do {
      const [files, next] = await this.bucket().getFiles({ prefix, autoPaginate: false, maxResults: 1000, ...(pageToken ? { pageToken } : {}) });
      for (const f of files) names.push(f.name);
      pageToken = (next as { pageToken?: string } | undefined)?.pageToken;
    } while (pageToken);
    await this.bucket().deleteFiles({ prefix, force: true });
    return names.sort();
  }
}

/** Something holding objects by full path (the other in-memory stores in tests / offline dev). */
export type ObjectMap = Map<string, unknown>;

/**
 * Tests / offline dev (STORAGE_DRIVER=memory). Owns tiles, marked PDFs and ZIPs; `linked` maps (sources of
 * InMemoryObjectStorage, exports/evidence of InMemoryBoqStorage, artifacts of InMemoryArtifactReader) are read for
 * sources and wiped by the purge, like one bucket.
 */
export class InMemoryGovernanceStorage implements GovernanceStorage {
  readonly objects = new Map<string, Buffer>();
  readonly linked: ObjectMap[] = [];

  link(...maps: ObjectMap[]): void {
    this.linked.push(...maps);
  }

  putTile(path: string, data: Buffer): void {
    assert(TILE_PATH_RE, path, 'tile');
    this.objects.set(path, data);
  }

  putMarkedPdf(path: string, data: Buffer): void {
    assert(MARKED_PDF_PATH_RE, path, 'marked pdf');
    this.objects.set(path, data);
  }

  async readTile(path: string): Promise<Buffer | null> {
    assert(TILE_PATH_RE, path, 'tile');
    return this.objects.get(path) ?? null;
  }

  async objectExists(path: string): Promise<boolean> {
    assert(MARKED_PDF_PATH_RE, path, 'marked pdf');
    return this.objects.has(path);
  }

  async signMarkedPdf(path: string, fileName: string, ttlSeconds: number): Promise<SignedUrl> {
    assert(MARKED_PDF_PATH_RE, path, 'marked pdf');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    return { url: `https://storage.invalid/test-bucket/${encodeURI(path)}?X-Goog-Expires=${ttlSeconds}&response-content-disposition=${encodeURIComponent(contentDisposition(fileName))}`, expiresAt };
  }

  async openSource(path: string): Promise<Readable | null> {
    assert(PROJECT_UPLOAD_PATH_RE, path, 'source');
    for (const m of [this.objects as ObjectMap, ...this.linked]) {
      const o = m.get(path);
      const data = Buffer.isBuffer(o) ? o : o && typeof o === 'object' && Buffer.isBuffer((o as { data?: unknown }).data) ? (o as { data: Buffer }).data : null;
      if (data) return Readable.from([data]);
    }
    return null;
  }

  createZipWriter(path: string): Writable {
    assert(OFFBOARDING_ZIP_PATH_RE, path, 'offboarding zip');
    const chunks: Buffer[] = [];
    const objects = this.objects;
    return new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
      final(cb) {
        objects.set(path, Buffer.concat(chunks));
        cb();
      },
    });
  }

  async signZip(path: string, fileName: string, ttlSeconds: number): Promise<SignedUrl> {
    assert(OFFBOARDING_ZIP_PATH_RE, path, 'offboarding zip');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    return { url: `https://storage.invalid/test-bucket/${encodeURI(path)}?X-Goog-Expires=${ttlSeconds}&response-content-disposition=${encodeURIComponent(contentDisposition(fileName))}`, expiresAt };
  }

  async writeShareSnapshot(path: string, value: unknown): Promise<void> {
    assert(SHARE_BOQ_SNAPSHOT_PATH_RE, path, 'share snapshot');
    this.objects.set(path, gzipSync(Buffer.from(JSON.stringify(value))));
  }

  async readShareSnapshot(path: string): Promise<unknown | null> {
    assert(SHARE_BOQ_SNAPSHOT_PATH_RE, path, 'share snapshot');
    const b = this.objects.get(path);
    return b ? decodeGzipJson(b) : null;
  }

  async deleteOrgObjects(orgId: string): Promise<string[]> {
    if (!ORG_ID_RE.test(orgId)) throw new Error('invalid org id');
    const prefix = `orgs/${orgId}/`;
    const names: string[] = [];
    for (const m of [this.objects as ObjectMap, ...this.linked]) {
      for (const k of [...m.keys()]) {
        if (k.startsWith(prefix)) {
          names.push(k);
          m.delete(k);
        }
      }
    }
    return names.sort();
  }
}
