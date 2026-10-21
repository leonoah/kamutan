import { describe, expect, it } from 'vitest';
import {
  CreateMarkedPdfRequestSchema,
  CreateShareLinkRequestSchema,
  DetectionSchema,
  ExportRecordSchema,
  IngestTopicJobSchema,
  MarkedPdfJobSchema,
  PatchOrgSettingsRequestSchema,
  RoomSchema,
  ShareLinkSchema,
  ShareLinkViewSchema,
  SheetVersionSchema,
  storagePaths,
  TILE_PATH_RE,
  VersionStatsSchema,
} from '../src/index.js';

const job = {
  schemaVersion: 1, type: 'export.marked_pdf', jobId: 'j1', orgId: 'o1', projectId: 'p1', exportId: 'e1', sheetIds: null, versionIds: null,
  options: { legend: true, floorSplit: false, watermark: null, hideTitleBlock: false }, storagePath: 'orgs/o1/projects/p1/exports/e1/marked.pdf', traceparent: null,
};

describe('Sprint 5 contracts', () => {
  it('MarkedPdfJob is in the ingest union and pins its storage path', () => {
    expect(IngestTopicJobSchema.safeParse(job).success).toBe(true);
    expect(MarkedPdfJobSchema.safeParse({ ...job, storagePath: 'orgs/o2/projects/p1/exports/e1/marked.pdf' }).success).toBe(false);
    expect(storagePaths.markedPdf('o1', 'p1', 'e1')).toBe(job.storagePath);
    expect(TILE_PATH_RE.test(storagePaths.tile('o', 'p', 's', 'v', 3, 1, 2))).toBe(true);
  });
  it('marked PDF request defaults; legend cannot be switched off', () => {
    expect(CreateMarkedPdfRequestSchema.parse({})).toEqual({ sheetIds: null, options: {} });
    expect(CreateMarkedPdfRequestSchema.safeParse({ options: { legend: false } }).success).toBe(false);
  });
  it('export record accepts worker bookkeeping (startedAt, versionIds)', () => {
    const r = ExportRecordSchema.safeParse({ id: 'e', kind: 'marked_pdf', status: 'ready', storagePath: 'x', pageCount: 2, sizeBytes: 9, createdBy: 'u', createdAt: '2026-10-20T10:00:00Z', startedAt: '2026-10-20T10:00:01Z', finishedAt: null, error: null, versionIds: { s: 'v' } });
    expect(r.success).toBe(true);
  });
  it('share links: Sprint-0 doc still valid; view omits tokenHash; create request ranges', () => {
    const base = { id: 'l', tokenHash: 'a'.repeat(64), versionLock: [], expiresAt: '2026-10-20T10:00:00Z', revokedAt: null, allowPdfDownload: false, createdBy: 'u', createdAt: '2026-10-20T10:00:00Z' };
    expect(ShareLinkSchema.safeParse(base).success).toBe(true);
    expect('tokenHash' in ShareLinkViewSchema.shape).toBe(false);
    expect(CreateShareLinkRequestSchema.parse({ label: 'x' })).toMatchObject({ days: 14, hideTitleBlock: true, allowPdfDownload: false });
    expect(CreateShareLinkRequestSchema.safeParse({ label: 'x', days: 91 }).success).toBe(false);
  });
  it('org settings PATCH ranges', () => {
    expect(PatchOrgSettingsRequestSchema.safeParse({ greenThreshold: 0.9 }).success).toBe(true);
    expect(PatchOrgSettingsRequestSchema.safeParse({ greenThreshold: 0.996 }).success).toBe(false);
    expect(PatchOrgSettingsRequestSchema.safeParse({}).success).toBe(false);
  });
  it('additive worker fields: scoreRaw, niche/parentRoomId/open, calibration + timings, titleBlock', () => {
    expect(DetectionSchema.shape.scoreRaw.safeParse(undefined).success).toBe(true);
    expect(RoomSchema.shape.type.safeParse('niche').success).toBe(true);
    expect(VersionStatsSchema.safeParse({ paths: 1, segments: 1, textLines: 0, glyphs: 0, calibration: { mode: 'conservative', version: '2026.10.1' }, timingsMs: { render: 4100 } }).success).toBe(true);
    expect(SheetVersionSchema.shape.titleBlock.safeParse({ bboxMm: [1, 2, 3, 4] }).success).toBe(true);
  });
});
