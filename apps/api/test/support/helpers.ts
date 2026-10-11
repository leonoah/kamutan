import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import { loadConfig, type AppConfig } from '../../src/config/config';

export const JWT_SECRET = 'test-jwt-secret-test-jwt-secret-0123456789';
export const UPLOAD_SECRET = 'test-upload-secret-test-upload-secret-0123';

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PUBLIC_API_URL: 'http://api.test',
    CORS_ORIGINS: 'http://localhost:5173',
    SUPABASE_JWT_SECRET: JWT_SECRET,
    DATA_DRIVER: 'memory',
    QUEUE_DRIVER: 'memory',
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_DIR: mkdtempSync(join(tmpdir(), 'kamutan-api-test-')),
    UPLOAD_TOKEN_SECRET: UPLOAD_SECRET,
    SWAGGER_ENABLED: 'false',
    ...overrides,
  });
}

export async function makeToken(
  sub: string,
  opts: { role?: string; aal?: 'aal1' | 'aal2'; expiresIn?: string | number; secret?: string; audience?: string } = {},
): Promise<string> {
  return new SignJWT({ role: opts.role ?? 'authenticated', aal: opts.aal ?? 'aal1', session_id: randomUUID() })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(sub)
    .setAudience(opts.audience ?? 'authenticated')
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '1h')
    .sign(new TextEncoder().encode(opts.secret ?? JWT_SECRET));
}

/** Minimal valid file bodies per kind. */
export const SAMPLE = {
  pdf: Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'),
  png: Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from('IHDR'),
    Buffer.alloc(17),
  ]),
  dxf: Buffer.from('999\r\ndxfrw 0.6.3\r\n  0\r\nSECTION\r\n  2\r\nHEADER\r\n  9\r\n$ACADVER\r\n  1\r\nAC1015\r\n  0\r\nENDSEC\r\n  0\r\nEOF\r\n'),
  dwg: Buffer.concat([Buffer.from('AC1032'), Buffer.alloc(64)]),
};
