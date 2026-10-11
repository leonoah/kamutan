import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { signJson, verifyJson } from '../upload-token';
import { assertSafePath, type ObjectStorage, type SignedUpload } from './object-storage';
import { TooLargeError } from '../inspect';

const DOMAIN = 'kamutan.local-storage.v1';

interface LocalUploadGrant {
  path: string;
  max: number;
  exp: number;
}

/**
 * Filesystem-backed storage for development and tests (STORAGE_DRIVER=local,
 * rejected in production). Signed upload URLs point back at this API:
 * PUT {PUBLIC_API_URL}/v1/local-storage/{token}.
 */
export class LocalObjectStorage implements ObjectStorage {
  private readonly root: string;

  constructor(
    root: string,
    private readonly publicApiUrl: string,
    private readonly secret: string,
  ) {
    this.root = resolve(root);
  }

  private file(path: string): string {
    assertSafePath(path);
    const full = resolve(join(this.root, path));
    if (!full.startsWith(this.root + sep)) throw new Error('path escapes storage root');
    return full;
  }

  async createSignedUpload(path: string, opts: { expiresInSec: number; maxBytes: number }): Promise<SignedUpload> {
    this.file(path);
    const grant: LocalUploadGrant = { path, max: opts.maxBytes, exp: Math.floor(Date.now() / 1000) + opts.expiresInSec };
    const token = signJson(this.secret, DOMAIN, grant);
    return {
      url: `${this.publicApiUrl.replace(/\/$/, '')}/v1/local-storage/${token}`,
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
    };
  }

  /** Validates a local upload token; returns the grant or null. */
  verifyGrant(token: string): LocalUploadGrant | null {
    const g = verifyJson<LocalUploadGrant>(this.secret, DOMAIN, token);
    if (!g || typeof g.path !== 'string' || typeof g.max !== 'number' || typeof g.exp !== 'number') return null;
    if (g.exp < Math.floor(Date.now() / 1000)) return null;
    return g;
  }

  /** Writes a body stream atomically, enforcing the byte limit. */
  async write(path: string, body: NodeJS.ReadableStream, maxBytes: number): Promise<number> {
    const target = this.file(path);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${randomUUID()}.part`;
    let size = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) cb(new TooLargeError(maxBytes));
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(body, limiter, createWriteStream(tmp, { flags: 'wx' }));
      await rename(tmp, target);
      return size;
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async openRead(path: string): Promise<AsyncIterable<Uint8Array> | null> {
    const f = this.file(path);
    try {
      await stat(f);
    } catch {
      return null;
    }
    return createReadStream(f);
  }

  async remove(path: string): Promise<void> {
    await rm(this.file(path), { force: true });
  }
}
