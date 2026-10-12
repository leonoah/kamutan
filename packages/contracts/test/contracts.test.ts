import { describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  BOQ_LINE_TRANSITIONS,
  BoqLineSchema,
  CreateUploadRequestSchema,
  IngestSheetVersionJobSchema,
  MAX_UPLOAD_BYTES,
  roleSatisfies,
  storagePaths,
} from '../src/index.js';

const org = 'org_AbC123';
const pid = 'proj123';
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
  it('builds ADR 0008 storage paths', () => {
    expect(storagePaths.upload(org, 'uid1', 'f1')).toBe(`orgs/${org}/uploads/uid1/f1`);
    expect(storagePaths.source(org, pid, sha, 'pdf')).toBe(`orgs/${org}/projects/${pid}/sources/${sha}.pdf`);
  });
});

describe('ingest job payload', () => {
  const ok = {
    schemaVersion: 2,
    type: 'ingest.sheet_version',
    jobId: 'job1',
    orgId: org,
    projectId: pid,
    sheetSetId: 'set1',
    sheetId: 'sheet1',
    versionId: 'v1',
    storagePath: storagePaths.source(org, pid, sha, 'pdf'),
    sha256: sha,
    fileKind: 'pdf',
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  };
  it('parses a valid payload', () => {
    expect(IngestSheetVersionJobSchema.parse(ok)).toEqual(ok);
  });
  it('rejects foreign / traversal paths and bad traceparent', () => {
    expect(IngestSheetVersionJobSchema.safeParse({ ...ok, storagePath: '../etc/passwd' }).success).toBe(false);
    expect(IngestSheetVersionJobSchema.safeParse({ ...ok, storagePath: storagePaths.source('other', pid, sha, 'pdf') }).success).toBe(false);
    expect(IngestSheetVersionJobSchema.safeParse({ ...ok, traceparent: 'nope' }).success).toBe(false);
    expect(IngestSheetVersionJobSchema.safeParse({ ...ok, traceparent: null }).success).toBe(true);
  });
});

describe('boq', () => {
  it('keeps item codes as text ("4.10" != "4.1")', () => {
    const line = { id: 'l1', chapter: '4', code: '4.10', description: 'x', qty: 3, unit: "יח'", level: 'yellow', status: 'draft' };
    expect(BoqLineSchema.parse(line).code).toBe('4.10');
    expect(BoqLineSchema.safeParse({ ...line, code: 4.1 }).success).toBe(false);
    expect(BOQ_LINE_TRANSITIONS.draft).toEqual(['reviewed']);
  });
});

describe('api error', () => {
  it('has a stable shape', () => {
    expect(ApiErrorSchema.safeParse({ error: { code: 'not_found', message: 'x', requestId: null } }).success).toBe(true);
  });
});
