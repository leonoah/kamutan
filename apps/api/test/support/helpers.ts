import { loadConfig, type AppConfig } from '../../src/config/config';

export const UPLOAD_SECRET = 'test-upload-secret-test-upload-secret-0123';

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATA_DRIVER: 'memory',
    QUEUE_DRIVER: 'memory',
    STORAGE_DRIVER: 'memory',
    UPLOAD_TOKEN_SECRET: UPLOAD_SECRET,
    SWAGGER_ENABLED: 'false',
    ...overrides,
  });
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
