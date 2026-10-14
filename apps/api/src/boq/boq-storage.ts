import { gzipSync } from 'node:zlib';
import { BOQ_EVIDENCE_PATH_RE, BOQ_EXPORT_PATH_RE, LIBRARY_IMPORT_PATH_RE } from '@kamutan/contracts';
import type { App } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { ArtifactTooLargeError, decodeGzipJson, MAX_ARTIFACT_GZ_BYTES } from '../understanding/artifact-reader';
import type { SignedUrl } from '../sheets/url-signer';

export const BOQ_STORAGE = Symbol('BOQ_STORAGE');

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Sprint 3 object access, each operation pinned to ONE path shape (callers derive paths from authorized ids):
 *  - read  orgs/{o}/projects/{p}/boq/{buildId}/evidence.json.gz   (worker output, gzip JSON, size-capped)
 *  - write orgs/{o}/projects/{p}/exports/{exportId}.xlsx          (+ 2-minute signed download URL, attachment)
 *  - read / delete orgs/{o}/imports/{uuid}.{xls|xlsx}             (client upload slot, verified on finalize)
 */
export interface BoqStorage {
  readEvidence(path: string): Promise<unknown | null>;
  writeExport(path: string, data: Buffer): Promise<void>;
  signExport(path: string, fileName: string, ttlSeconds: number): Promise<SignedUrl>;
  /** Whole object (≤ maxBytes) or null when missing; throws ImportTooLargeError above the cap. */
  readImport(path: string, maxBytes: number): Promise<Buffer | null>;
  removeImport(path: string): Promise<void>;
}

export class ImportTooLargeError extends Error {}

const assert = (re: RegExp, path: string, what: string) => {
  if (!re.test(path)) throw new Error(`refusing to touch a non-${what} path`);
};

/** RFC 6266 attachment header with an ASCII fallback + UTF-8 filename*. */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export class FirebaseBoqStorage implements BoqStorage {
  constructor(
    private readonly app: App,
    private readonly bucketName: string,
  ) {}

  private file(path: string) {
    return getStorage(this.app).bucket(this.bucketName).file(path);
  }

  async readEvidence(path: string): Promise<unknown | null> {
    assert(BOQ_EVIDENCE_PATH_RE, path, 'evidence');
    const file = this.file(path);
    try {
      const [meta] = await file.getMetadata();
      if (Number(meta.size ?? 0) > MAX_ARTIFACT_GZ_BYTES) throw new ArtifactTooLargeError('evidence too large');
      const [buf] = await file.download({ decompress: false, validation: false });
      return decodeGzipJson(buf);
    } catch (err) {
      if ((err as { code?: number }).code === 404) return null;
      throw err;
    }
  }

  async writeExport(path: string, data: Buffer): Promise<void> {
    assert(BOQ_EXPORT_PATH_RE, path, 'export');
    await this.file(path).save(data, {
      resumable: false,
      contentType: XLSX_CONTENT_TYPE,
      metadata: { contentDisposition: 'attachment', cacheControl: 'private, max-age=0, no-store' },
    });
  }

  async signExport(path: string, fileName: string, ttlSeconds: number): Promise<SignedUrl> {
    assert(BOQ_EXPORT_PATH_RE, path, 'export');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const [url] = await this.file(path).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: expiresAt,
      responseDisposition: contentDisposition(fileName),
      responseType: XLSX_CONTENT_TYPE,
    });
    return { url, expiresAt };
  }

  async readImport(path: string, maxBytes: number): Promise<Buffer | null> {
    assert(LIBRARY_IMPORT_PATH_RE, path, 'import');
    const file = this.file(path);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [meta] = await file.getMetadata();
    if (Number(meta.size ?? 0) > maxBytes) throw new ImportTooLargeError('import too large');
    const [buf] = await file.download({ validation: false });
    if (buf.length > maxBytes) throw new ImportTooLargeError('import too large');
    return buf;
  }

  async removeImport(path: string): Promise<void> {
    assert(LIBRARY_IMPORT_PATH_RE, path, 'import');
    await this.file(path).delete({ ignoreNotFound: true });
  }
}

/** Tests / offline dev (STORAGE_DRIVER=memory). */
export class InMemoryBoqStorage implements BoqStorage {
  readonly objects = new Map<string, Buffer>();
  evidenceReads = 0;

  putEvidence(path: string, value: unknown): void {
    assert(BOQ_EVIDENCE_PATH_RE, path, 'evidence');
    this.objects.set(path, gzipSync(Buffer.from(JSON.stringify(value))));
  }

  /** Stands in for the client's direct upload to the import slot. */
  putImport(path: string, data: Buffer): void {
    assert(LIBRARY_IMPORT_PATH_RE, path, 'import');
    this.objects.set(path, data);
  }

  async readEvidence(path: string): Promise<unknown | null> {
    assert(BOQ_EVIDENCE_PATH_RE, path, 'evidence');
    this.evidenceReads++;
    const b = this.objects.get(path);
    return b ? decodeGzipJson(b) : null;
  }

  async writeExport(path: string, data: Buffer): Promise<void> {
    assert(BOQ_EXPORT_PATH_RE, path, 'export');
    this.objects.set(path, data);
  }

  async signExport(path: string, fileName: string, ttlSeconds: number): Promise<SignedUrl> {
    assert(BOQ_EXPORT_PATH_RE, path, 'export');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    return {
      url: `https://storage.invalid/test-bucket/${encodeURI(path)}?X-Goog-Expires=${ttlSeconds}&response-content-disposition=${encodeURIComponent(contentDisposition(fileName))}`,
      expiresAt,
    };
  }

  async readImport(path: string, maxBytes: number): Promise<Buffer | null> {
    assert(LIBRARY_IMPORT_PATH_RE, path, 'import');
    const b = this.objects.get(path);
    if (!b) return null;
    if (b.length > maxBytes) throw new ImportTooLargeError('import too large');
    return b;
  }

  async removeImport(path: string): Promise<void> {
    assert(LIBRARY_IMPORT_PATH_RE, path, 'import');
    this.objects.delete(path);
  }
}
