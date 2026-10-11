import { describe, expect, it } from 'vitest';
import { kindFromFilename, sanitizeFilename } from '../../src/uploads/filename';
import { inspectStream, TooLargeError } from '../../src/uploads/inspect';
import { UploadTokenError, UploadTokenSigner, type UploadTokenClaims } from '../../src/uploads/upload-token';
import { UPLOAD_SECRET } from '../support/helpers';

const ORG = '11111111-1111-4111-8111-111111111111';
const UID = '22222222-2222-4222-8222-222222222222';

describe('filename', () => {
  it('maps extensions case-insensitively', () => {
    expect(kindFromFilename('A.PDF')).toBe('pdf');
    expect(kindFromFilename('x.Dxf')).toBe('dxf');
    expect(kindFromFilename('x.png')).toBe('png');
    expect(kindFromFilename('x.pdf.exe')).toBeNull();
    expect(kindFromFilename('noext')).toBeNull();
  });

  it('sanitizes paths, control and bidi characters, keeps Hebrew', () => {
    expect(sanitizeFilename('../../etc/passwd.pdf')).toBe('passwd.pdf');
    expect(sanitizeFilename('C:\\Users\\x\\חשמל קומה א.pdf')).toBe('חשמל קומה א.pdf');
    expect(sanitizeFilename('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
    expect(sanitizeFilename('a\u0000b\nc.pdf')).toBe('abc.pdf');
    expect(sanitizeFilename('...hidden.pdf')).toBe('hidden.pdf');
    expect(sanitizeFilename('   ', 'pdf')).toBe('upload.pdf');
    const long = sanitizeFilename(`${'א'.repeat(300)}.pdf`);
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith('.pdf')).toBe(true);
  });
});

describe('upload token', () => {
  const signer = new UploadTokenSigner(UPLOAD_SECRET);
  const claims: UploadTokenClaims = {
    v: 1,
    uid: UID,
    org: ORG,
    prj: UID,
    usr: UID,
    path: `${ORG}/upload/${UID}`,
    name: 'a.pdf',
    kind: 'pdf',
    size: 10,
    exp: Math.floor(Date.now() / 1000) + 60,
  };

  it('round-trips', () => {
    expect(signer.verify(signer.sign(claims))).toEqual(claims);
  });

  it('rejects tampering, foreign keys and expiry', () => {
    const t = signer.sign(claims);
    const [body, sig] = t.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...claims, org: UID })).toString('base64url');
    expect(() => signer.verify(`${forged}.${sig}`)).toThrow(UploadTokenError);
    expect(() => new UploadTokenSigner('another-secret-another-secret-0123456').verify(t)).toThrow(UploadTokenError);
    expect(() => signer.verify(`${body}`)).toThrow(UploadTokenError);
    const expired = signer.sign({ ...claims, exp: 1 });
    expect(() => signer.verify(expired)).toThrow(expect.objectContaining({ reason: 'expired' }));
  });
});

describe('inspectStream', () => {
  async function* chunks(...parts: string[]) {
    for (const p of parts) yield Buffer.from(p);
  }

  it('hashes, counts and keeps the head', async () => {
    const r = await inspectStream(chunks('%PDF-', '1.7 rest'), 100);
    expect(r.size).toBe(13);
    expect(Buffer.from(r.head).toString()).toBe('%PDF-1.7 rest');
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('aborts past the limit', async () => {
    await expect(inspectStream(chunks('12345', '67890'), 8)).rejects.toBeInstanceOf(TooLargeError);
  });
});
