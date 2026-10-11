import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { assertSafePath, type ObjectStorage, type SignedUpload } from './object-storage';

/**
 * Supabase Storage over its REST API with the service-role key (server side only).
 * NOTE: Supabase signed upload URLs have a fixed 2h validity; the 10-minute
 * window of SEC-13 is enforced by the upload token checked on finalize.
 */
export class SupabaseObjectStorage implements ObjectStorage {
  private readonly base: string;

  constructor(
    supabaseUrl: string,
    private readonly serviceKey: string,
    private readonly bucket: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = `${supabaseUrl.replace(/\/$/, '')}/storage/v1`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.serviceKey}`, apikey: this.serviceKey, ...extra };
  }

  private objectUrl(kind: string, path: string): string {
    return `${this.base}/${kind}/${encodeURIComponent(this.bucket)}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  async createSignedUpload(path: string, _opts: { expiresInSec: number; maxBytes: number }): Promise<SignedUpload> {
    assertSafePath(path);
    const res = await this.fetchImpl(this.objectUrl('object/upload/sign', path), {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: '{}',
    });
    if (!res.ok) throw new Error(`storage sign failed: HTTP ${res.status}`);
    const body = (await res.json()) as { url?: string };
    if (!body.url) throw new Error('storage sign: missing url');
    return { url: `${this.base}${body.url}`, method: 'PUT', headers: { 'x-upsert': 'false' } };
  }

  async openRead(path: string): Promise<AsyncIterable<Uint8Array> | null> {
    assertSafePath(path);
    const res = await this.fetchImpl(this.objectUrl('object/authenticated', path), { headers: this.headers() });
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok || !res.body) throw new Error(`storage read failed: HTTP ${res.status}`);
    return Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
  }

  async remove(path: string): Promise<void> {
    assertSafePath(path);
    const res = await this.fetchImpl(`${this.base}/object/${encodeURIComponent(this.bucket)}`, {
      method: 'DELETE',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ prefixes: [path] }),
    });
    if (!res.ok && res.status !== 404) throw new Error(`storage delete failed: HTTP ${res.status}`);
  }
}
