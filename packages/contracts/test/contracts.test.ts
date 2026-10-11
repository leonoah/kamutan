import { describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  CreateUploadRequestSchema,
  IngestSheetVersionJobSchema,
  MAX_UPLOAD_BYTES,
  roleSatisfies,
} from '../src/index.js';

const uuid = '0b6f2c1e-6a0e-4f43-9a51-2a4d2f8f0a11';
const sha = 'a'.repeat(64);

describe('roles', () => {
  it('orders roles admin > editor > reviewer > viewer', () => {
    expect(roleSatisfies('admin', 'editor')).toBe(true);
    expect(roleSatisfies('editor', 'editor')).toBe(true);
    expect(roleSatisfies('reviewer', 'editor')).toBe(false);
    expect(roleSatisfies('viewer', 'reviewer')).toBe(false);
  });
});

describe('uploads', () => {
  it('accepts allowed extensions up to 100MB', () => {
    expect(CreateUploadRequestSchema.safeParse({ filename: 'תוכנית חשמל.PDF', sizeBytes: 10 }).success).toBe(true);
    expect(CreateUploadRequestSchema.safeParse({ filename: 'a.dwg', sizeBytes: MAX_UPLOAD_BYTES }).success).toBe(true);
  });
  it('rejects oversize, bad extension and unknown keys', () => {
    expect(CreateUploadRequestSchema.safeParse({ filename: 'a.pdf', sizeBytes: MAX_UPLOAD_BYTES + 1 }).success).toBe(false);
    expect(CreateUploadRequestSchema.safeParse({ filename: 'a.exe', sizeBytes: 1 }).success).toBe(false);
    expect(CreateUploadRequestSchema.safeParse({ filename: 'a.pdf', sizeBytes: 1, x: 1 }).success).toBe(false);
  });
});

describe('ingest job payload', () => {
  const ok = {
    schemaVersion: 1,
    sheetVersionId: uuid,
    orgId: uuid,
    projectId: uuid,
    storagePath: `${uuid}/upload/${uuid}`,
    sha256: sha,
    fileKind: 'pdf',
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  };
  it('parses a valid payload', () => {
    expect(IngestSheetVersionJobSchema.parse(ok)).toEqual(ok);
  });
  it('rejects path traversal / foreign paths and bad traceparent', () => {
    expect(IngestSheetVersionJobSchema.safeParse({ ...ok, storagePath: '../etc/passwd' }).success).toBe(false);
    const other = '1b6f2c1e-6a0e-4f43-9a51-2a4d2f8f0a11';
    expect(IngestSheetVersionJobSchema.safeParse({ ...ok, storagePath: `${other}/upload/${uuid}` }).success).toBe(false);
    expect(IngestSheetVersionJobSchema.safeParse({ ...ok, traceparent: 'nope' }).success).toBe(false);
    expect(IngestSheetVersionJobSchema.safeParse({ ...ok, traceparent: null }).success).toBe(true);
  });
});

describe('api error', () => {
  it('has a stable shape', () => {
    expect(
      ApiErrorSchema.safeParse({ error: { code: 'not_found', message: 'x', requestId: null } }).success,
    ).toBe(true);
  });
});
