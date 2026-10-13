import { describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  BOQ_LINE_TRANSITIONS,
  BoqLineSchema,
  CreateUploadRequestSchema,
  IngestSheetVersionJobSchema,
  IngestSheetVersionJobV2Schema,
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
    expect(storagePaths.quarantine(org, 'f1')).toBe(`orgs/${org}/quarantine/f1`);
    expect(storagePaths.projectUpload(org, pid, sha, 'pdf')).toBe(`orgs/${org}/projects/${pid}/uploads/${sha}/source.pdf`);
    expect(storagePaths.tile(org, pid, 's', 'v', 3, 1, 2)).toBe(`orgs/${org}/projects/${pid}/sheets/s/versions/v/tiles/3/1_2.webp`);
  });
});

describe('ingest job payload (schemaVersion 3)', () => {
  const ok = {
    schemaVersion: 3,
    type: 'ingest.sheet_version',
    jobId: 'job1',
    orgId: org,
    projectId: pid,
    sheetSetId: sha,
    sheetId: null,
    pageIndex: null,
    versionId: 'v1',
    storagePath: storagePaths.projectUpload(org, pid, sha, 'pdf'),
    sha256: sha,
    fileKind: 'pdf',
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  };
  it('parses initial and reprocess payloads', () => {
    expect(IngestSheetVersionJobSchema.parse(ok)).toEqual(ok);
    const re = { ...ok, sheetId: `${sha}-p3`, pageIndex: 3 };
    expect(IngestSheetVersionJobSchema.parse(re)).toEqual(re);
  });
  it('rejects foreign / traversal paths, half-set reprocess fields and bad traceparent', () => {
    expect(IngestSheetVersionJobSchema.safeParse({ ...ok, storagePath: '../etc/passwd' }).success).toBe(false);
    expect(IngestSheetVersionJobSchema.safeParse({ ...ok, storagePath: storagePaths.projectUpload('other', pid, sha, 'pdf') }).success).toBe(false);
    expect(IngestSheetVersionJobSchema.safeParse({ ...ok, storagePath: storagePaths.projectUpload(org, pid, 'set2', 'pdf') }).success).toBe(false);
    expect(IngestSheetVersionJobSchema.safeParse({ ...ok, storagePath: storagePaths.projectUpload(org, pid, sha, 'png') }).success).toBe(false);
    expect(IngestSheetVersionJobSchema.safeParse({ ...ok, sheetId: 's1' }).success).toBe(false);
    expect(IngestSheetVersionJobSchema.safeParse({ ...ok, traceparent: 'nope' }).success).toBe(false);
    expect(IngestSheetVersionJobSchema.safeParse({ ...ok, traceparent: null }).success).toBe(true);
    expect(IngestSheetVersionJobSchema.safeParse({ ...ok, schemaVersion: 2 }).success).toBe(false);
  });
  it('keeps the Sprint 0 (v2) schema exported', () => {
    const v2 = {
      schemaVersion: 2, type: 'ingest.sheet_version', jobId: 'j', orgId: org, projectId: pid, sheetSetId: 's', sheetId: 'sh',
      versionId: 'v', storagePath: storagePaths.source(org, pid, sha, 'pdf'), sha256: sha, fileKind: 'pdf', traceparent: null,
    };
    expect(IngestSheetVersionJobV2Schema.safeParse(v2).success).toBe(true);
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
