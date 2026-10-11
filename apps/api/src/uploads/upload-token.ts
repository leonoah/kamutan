import { createHmac, timingSafeEqual } from 'node:crypto';
import { FileKindSchema, StoragePathSchema, UuidSchema } from '@kamutan/contracts';
import { z } from 'zod';

/** Claims carried by the opaque upload token (stateless pending upload). */
export const UploadTokenClaimsSchema = z
  .object({
    v: z.literal(1),
    uid: UuidSchema, // upload id
    org: UuidSchema,
    prj: UuidSchema,
    usr: UuidSchema,
    path: StoragePathSchema,
    name: z.string().min(1).max(255),
    kind: FileKindSchema,
    size: z.number().int().positive(),
    exp: z.number().int(), // unix seconds
  })
  .strict();
export type UploadTokenClaims = z.infer<typeof UploadTokenClaimsSchema>;

export class UploadTokenError extends Error {
  constructor(readonly reason: 'malformed' | 'signature' | 'expired') {
    super(`upload token ${reason}`);
  }
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** HMAC-SHA256 signed token: base64url(json).base64url(mac), domain-separated. */
export class UploadTokenSigner {
  private readonly key: Buffer;

  constructor(secret: string, private readonly domain = 'kamutan.upload.v1') {
    if (secret.length < 32) throw new Error('upload token secret must be >= 32 chars');
    this.key = Buffer.from(secret, 'utf8');
  }

  private mac(body: string): Buffer {
    return createHmac('sha256', this.key).update(`${this.domain}.${body}`).digest();
  }

  sign(claims: UploadTokenClaims): string {
    const body = b64(JSON.stringify(UploadTokenClaimsSchema.parse(claims)));
    return `${body}.${b64(this.mac(body))}`;
  }

  verify(token: string, nowSec = Math.floor(Date.now() / 1000)): UploadTokenClaims {
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new UploadTokenError('malformed');
    const [body, sig] = parts as [string, string];
    const expected = this.mac(body);
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new UploadTokenError('signature');
    let parsed: UploadTokenClaims;
    try {
      parsed = UploadTokenClaimsSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
    } catch {
      throw new UploadTokenError('malformed');
    }
    if (parsed.exp < nowSec) throw new UploadTokenError('expired');
    return parsed;
  }
}

/** Generic signer for small JSON payloads (local-storage upload URLs). */
export function signJson(secret: string, domain: string, payload: unknown): string {
  const body = b64(JSON.stringify(payload));
  const mac = createHmac('sha256', secret).update(`${domain}.${body}`).digest();
  return `${body}.${b64(mac)}`;
}

export function verifyJson<T>(secret: string, domain: string, token: string): T | null {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = createHmac('sha256', secret).update(`${domain}.${body}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}
