import { createHmac, timingSafeEqual } from 'node:crypto';
import { DocIdSchema, FileKindSchema, QUARANTINE_PATH_RE, UidSchema } from '@kamutan/contracts';
import { z } from 'zod';

/** Claims carried by the opaque upload token (stateless pending upload). */
export const UploadTokenClaimsSchema = z
  .object({
    v: z.literal(3),
    fid: z.string().uuid(), // pending upload id (quarantine object name)
    org: DocIdSchema,
    prj: DocIdSchema,
    usr: UidSchema,
    path: z.string().regex(QUARANTINE_PATH_RE),
    name: z.string().min(1).max(255),
    kind: FileKindSchema,
    size: z.number().int().positive(),
    exp: z.number().int(), // unix seconds
  })
  .strict()
  .refine((c) => c.path === `orgs/${c.org}/quarantine/${c.fid}`, { message: 'path does not match claims' });
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

  constructor(
    secret: string,
    private readonly domain = 'kamutan.upload.v3',
  ) {
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
