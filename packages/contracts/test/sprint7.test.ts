import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  applyRebuild,
  ARTIFACT_PATH_RE,
  auditSummaryHe,
  BOQ_LINE_PRESERVED_FIELDS,
  BoqDocumentModelSchema,
  BoqDocumentQuerySchema,
  BoqLineSchema,
  DEFAULT_PROJECT_QUOTA_BYTES,
  displayDescription,
  ExportBoqRequestSchema,
  INFECTED_PATH_RE,
  isDescriptionOverridden,
  jsonSchemaRegistry,
  LINE_HISTORY_ACTIONS,
  normalizeDescriptionInput,
  OrgSettingsSchema,
  PatchBoqLineRequestSchema,
  PatchOrgSettingsRequestSchema,
  projectQuotaOf,
  ProjectSchema,
  quotaExceededMessageHe,
  SheetSetSchema,
  SheetSetStatusResponseSchema,
  storagePaths,
  UPLOAD_ERROR_MESSAGES_HE,
} from '../src/index.js';

const SHA = 'a'.repeat(64);

describe('Sprint 7 — line rename (descriptionOverride)', () => {
  it('BoqLine accepts the four fields; ≤ 500 chars', () => {
    const base = { id: 'l1', chapter: '04', code: '4.10', description: 'נקודת מאור', qty: 1, unit: "יח'", level: 'green', status: 'draft' };
    expect(BoqLineSchema.parse({ ...base, descriptionOverride: 'נקודת מאור תקרה', descriptionOverrideBy: 'u1', descriptionOverrideAt: '2026-11-04T10:00:00.000Z', descriptionOverrideReason: null }).descriptionOverride).toBe('נקודת מאור תקרה');
    expect(BoqLineSchema.safeParse({ ...base, descriptionOverride: 'x'.repeat(501) }).success).toBe(false);
  });
  it('displayDescription / isDescriptionOverridden', () => {
    expect(displayDescription({ description: 'a', descriptionOverride: 'b' })).toBe('b');
    expect(displayDescription({ description: 'a', descriptionOverride: null })).toBe('a');
    expect(displayDescription({ description: 'a' })).toBe('a');
    expect(isDescriptionOverridden({ descriptionOverride: '' })).toBe(false);
  });
  it('is preserved by a rebuild (worker reference semantics)', () => {
    for (const f of ['descriptionOverride', 'descriptionOverrideBy', 'descriptionOverrideAt', 'descriptionOverrideReason']) expect(BOQ_LINE_PRESERVED_FIELDS).toContain(f);
    const out = applyRebuild({ status: 'draft', descriptionOverride: 'שם ידני', descriptionOverrideBy: 'u1' }, { description: 'computed', qty: 3 });
    expect(out.descriptionOverride).toBe('שם ידני');
    expect(out.description).toBe('computed');
  });
  it('normalizeDescriptionInput: NFC, control chars and whitespace collapsed', () => {
    expect(normalizeDescriptionInput('  שקע\t\tכפול\r\n מוגן ')).toBe('שקע כפול מוגן');
    expect(normalizeDescriptionInput('é')).toBe('é');
  });
  it('PATCH: description / null / alsoUpdateLibrary / reason rules', () => {
    expect(PatchBoqLineRequestSchema.parse({ description: '  חדש  ' }).description).toBe('חדש');
    expect(PatchBoqLineRequestSchema.parse({ description: null }).description).toBeNull();
    expect(PatchBoqLineRequestSchema.parse({ description: 'x', reason: 'לפי המפרט', alsoUpdateLibrary: true }).alsoUpdateLibrary).toBe(true);
    expect(PatchBoqLineRequestSchema.safeParse({ description: '   ' }).success).toBe(false);
    expect(PatchBoqLineRequestSchema.safeParse({ description: 'x'.repeat(501) }).success).toBe(false);
    expect(PatchBoqLineRequestSchema.safeParse({ description: null, alsoUpdateLibrary: true }).success).toBe(false);
    expect(PatchBoqLineRequestSchema.safeParse({ description: null, reason: 'r' }).success).toBe(false);
    expect(PatchBoqLineRequestSchema.safeParse({ note: 'n', reason: 'r' }).success).toBe(false);
  });
  it('history action + audit summary before → after', () => {
    expect(LINE_HISTORY_ACTIONS).toContain('description');
    expect(auditSummaryHe({ entity: 'boqLines', action: 'update', entityId: 'l1', after: { code: '4.10', description: { from: 'א', to: 'ב' }, alsoUpdateLibrary: true } })).toContain('שם השורה עודכן: «א» → «ב»');
    expect(auditSummaryHe({ entity: 'boqLines', action: 'update', entityId: 'l1', after: { code: '4.10', description: { from: 'ב', to: null, original: 'א' } } })).toContain('שוחזר');
  });
});

describe('Sprint 7 — BOQ document model', () => {
  it('query = export dialog options', () => {
    expect(BoqDocumentQuerySchema.parse({})).toEqual({ split: 'summed', confidence: true, chapters: undefined, markDraft: false, prices: true });
    expect(BoqDocumentQuerySchema.parse({ split: 'floor', confidence: '0', chapters: '04, 05,04', markDraft: '1' })).toEqual({ split: 'byFloor', confidence: false, chapters: ['04', '05'], markDraft: true, prices: true });
    expect(BoqDocumentQuerySchema.parse({ split: 'none' }).split).toBe('summed');
    expect(BoqDocumentQuerySchema.safeParse({ split: 'room' }).success).toBe(false);
    expect(BoqDocumentQuerySchema.safeParse({ chapters: Array.from({ length: 65 }, (_, i) => String(i)).join(',') }).success).toBe(false);
    expect(BoqDocumentQuerySchema.safeParse({ other: '1' }).success).toBe(false);
  });
  it('export request takes the same options (defaults = Sprint 3–6 layout)', () => {
    expect(ExportBoqRequestSchema.parse({ includeConfidence: false, chapters: ['04'] })).toMatchObject({ includeConfidence: false, chapters: ['04'] });
  });
  it('model shape', () => {
    const m = {
      schema: 'kamutan.boq-document/1',
      projectId: 'p1',
      templateId: 'tpl_default',
      buildId: null,
      options: { split: 'summed', includeConfidence: true, chapters: null, markDraft: false },
      titleRows: [{ kind: 'title', text: 'כתב כמויות' }],
      columns: [{ key: 'code', title: 'סעיף', width: 8 }],
      chapters: [{ code: '04', title: 'חשמל', notes: ['1. הערה'], rows: [{ kind: 'line', lineId: 'l1', code: '4.10', description: 'x', unit: "יח'", qty: null, price: null, total: 0, level: 'red', status: 'draft', needsInput: true, cellNote: 'להשלמה ידנית' }], subtotal: 0 }],
      totals: { currency: 'ILS', linesTotal: 0, adjustmentPct: 0, adjustment: 0, beforeVat: 0, vat: 0, afterVat: 0, vatRate: 0.18, pricedLines: 0, unpricedLines: 1 },
      warnings: [{ kind: 'needsInput', count: 1 }],
      exportBlocked: true,
      counts: { lines: 1, green: 0, yellow: 0, red: 1, draft: 1, reviewed: 0, approved: 0, overridden: 0 },
      generatedAt: '2026-11-04T10:00:00.000Z',
    };
    expect(BoqDocumentModelSchema.parse(m).chapters).toHaveLength(1);
    expect(BoqDocumentModelSchema.safeParse({ ...m, warnings: [{ kind: 'red', count: 0 }] }).success).toBe(false);
  });
});

describe('Sprint 7 — upload hardening', () => {
  it('error codes', () => {
    expect(API_ERROR_CODES).toContain('quota_exceeded');
    expect(API_ERROR_CODES).toContain('file_infected');
    expect(UPLOAD_ERROR_MESSAGES_HE.file_infected).toMatch(/נוזקה/);
    expect(UPLOAD_ERROR_MESSAGES_HE.scan_unavailable).toBeTruthy();
  });
  it('quota setting + default 2 GB', () => {
    expect(DEFAULT_PROJECT_QUOTA_BYTES).toBe(2 * 1024 ** 3);
    expect(projectQuotaOf(undefined)).toBe(DEFAULT_PROJECT_QUOTA_BYTES);
    expect(projectQuotaOf({ projectQuotaBytes: 5e9 })).toBe(5e9);
    expect(OrgSettingsSchema.safeParse({ llmEnabled: false, blockExportOnRed: true, greenThreshold: 0.98, projectQuotaBytes: 5e9 }).success).toBe(true);
    expect(PatchOrgSettingsRequestSchema.safeParse({ projectQuotaBytes: 1000 }).success).toBe(false);
    expect(PatchOrgSettingsRequestSchema.safeParse({ projectQuotaBytes: 5 * 1024 ** 3 }).success).toBe(true);
  });
  it('Hebrew 413 message with the numbers', () => {
    const m = quotaExceededMessageHe(2 * 1024 ** 3 - 1024, 2 * 1024 ** 3, 50 * 1024 ** 2);
    expect(m).toContain('2 GB');
    expect(m).toContain('50 MB');
  });
  it('project storage fields + sheet-set error + status response', () => {
    expect(ProjectSchema.shape.storageBytes.safeParse(10).success).toBe(true);
    const set = { id: SHA, orgId: 'o1', projectId: 'p1', fileKind: 'pdf', sha256: SHA, storagePath: 'x', status: 'failed', uploadedBy: 'u1', createdAt: '2026-11-04T10:00:00.000Z', error: { code: 'file_infected', message: 'Eicar-Signature' } };
    expect(SheetSetSchema.parse(set).error?.code).toBe('file_infected');
    expect(SheetSetStatusResponseSchema.parse({ sheetSet: set, job: null, error: { code: 'file_infected', message: 'Eicar-Signature', messageHe: 'x' }, infected: true }).infected).toBe(true);
  });
  it('infected/ path is never a signable artifact', () => {
    const p = storagePaths.infected('o1', 'p1', SHA, SHA);
    expect(INFECTED_PATH_RE.test(p)).toBe(true);
    expect(INFECTED_PATH_RE.test(storagePaths.infectedImport('o1', '123e4567-e89b-12d3-a456-426614174000', SHA))).toBe(true);
    expect(ARTIFACT_PATH_RE.test(p)).toBe(false);
  });
  it('json-schema exported', () => {
    const dir = join(__dirname, '..', 'json-schema');
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { schemas: string[] };
    for (const n of ['BoqDocumentModel', 'BoqDocumentQuery', 'BoqDocumentRow', 'SheetSetStatusResponse']) {
      expect(Object.keys(jsonSchemaRegistry)).toContain(n);
      expect(index.schemas).toContain(`${n}.json`);
    }
  });
});
