import { describe, expect, it } from 'vitest';
import {
  adjustmentLabelHe,
  API_ERROR_CODES,
  applyRebuild,
  BOQ_LINE_API_FIELDS,
  BOQ_LINE_DERIVED_FIELDS,
  BOQ_LINE_PRESERVED_FIELDS,
  BoqCompareQuerySchema,
  BoqDocumentQuerySchema,
  BoqLinesSnapshotSchema,
  BulkLibraryPriceRequestSchema,
  computeBoqTotals,
  CreateLibraryImportRequestSchema,
  CreateShareLinkRequestSchema,
  deleteConfirmationMatches,
  DeleteProjectRequestSchema,
  effectivePrice,
  exceedsSheetLimit,
  ExportBoqRequestSchema,
  itemIdFor,
  jsonSchemaRegistry,
  LibraryImportJobSchema,
  libraryPriceFor,
  lineTotal,
  MAX_SHEETS_PER_PROJECT,
  normalizeDescription,
  PatchBoqLineRequestSchema,
  PatchLibraryItemRequestSchema,
  PatchOrgSettingsRequestSchema,
  PatchProjectPricingRequestSchema,
  planPriceImport,
  PriceImportReportSchema,
  sheetLimitMessageHe,
  SHARE_REVOKE_REASONS,
  storagePaths,
  BOQ_LINES_SNAPSHOT_PATH_RE,
  ARTIFACT_PATH_RE,
  UPLOAD_ERROR_MESSAGES_HE,
  vatLabelHe,
  vatRateOf,
  type ItemPrice,
  ApplyImportPricesRequestSchema,
  BoqBuildListQuerySchema,
  BoqBuildSummarySchema,
  ProjectSchema,
} from '../src/index.js';

const price = (amount: number, source: 'manual' | 'import' = 'manual', updatedAt = '2026-11-01T00:00:00.000Z'): ItemPrice => ({ amount, currency: 'ILS', updatedAt, by: 'u1', source });
const item = (code: string, description: string, p: ItemPrice | null, active = true) => ({ id: itemIdFor(code, description), code, description, active, price: p });

describe('Sprint 8 — prices', () => {
  it('libraryPriceFor: exact item first, else the most recently priced active item of the code; inactive never', () => {
    const items = [item('4.10', 'א', price(10, 'manual', '2026-10-01T00:00:00.000Z')), item('4.10', 'ב', price(20, 'manual', '2026-11-01T00:00:00.000Z')), item('4.11', 'ג', price(30), false)];
    expect(libraryPriceFor({ code: '4.10', description: 'א' }, items, itemIdFor)?.amount).toBe(10);
    expect(libraryPriceFor({ code: '4.10', description: 'אחר' }, items, itemIdFor)?.amount).toBe(20);
    expect(libraryPriceFor({ code: '4.11', description: 'ג' }, items, itemIdFor)).toBeNull();
    expect(libraryPriceFor({ code: '4.1', description: 'א' }, items, itemIdFor)).toBeNull(); // TEXT codes
  });

  it('effectivePrice / lineTotal: override wins; no price → null total; a null qty counts 0', () => {
    expect(effectivePrice({ priceOverride: 5 }, 9)).toEqual({ price: 5, source: 'override' });
    expect(effectivePrice({ priceOverride: null }, 9)).toEqual({ price: 9, source: 'library' });
    expect(effectivePrice({}, null)).toEqual({ price: null, source: null });
    expect([lineTotal(3, 2.5), lineTotal(null, 4), lineTotal(3, null)]).toEqual([7.5, 0, null]);
  });

  it('computeBoqTotals: lines → adjustment → before VAT → VAT → after VAT', () => {
    const t = computeBoqTotals({ linesTotal: 1000, adjustmentPct: -10, vatRate: 0.18, pricedLines: 3, unpricedLines: 1 });
    expect(t).toEqual({ currency: 'ILS', linesTotal: 1000, adjustmentPct: -10, adjustment: -100, beforeVat: 900, vat: 162, afterVat: 1062, vatRate: 0.18, pricedLines: 3, unpricedLines: 1 });
    expect(computeBoqTotals({ linesTotal: 0.1 + 0.2, vatRate: 0, pricedLines: 1, unpricedLines: 0 }).linesTotal).toBe(0.3);
    expect([adjustmentLabelHe(-5), adjustmentLabelHe(12.5), vatLabelHe(0.18), vatLabelHe(0.17)]).toEqual(['הנחה 5%', 'תוספת 12.5%', 'מע"מ 18%', 'מע"מ 17%']);
    expect([vatRateOf({}), vatRateOf({ vatRate: 0.17 }), vatRateOf(null)]).toEqual([0.18, 0.17, 0.18]);
  });

  it('request schemas: line priceOverride (+ optional reason), library price, bulk, project pricing, VAT setting', () => {
    expect(PatchBoqLineRequestSchema.safeParse({ priceOverride: 12.5 }).success).toBe(true);
    expect(PatchBoqLineRequestSchema.safeParse({ priceOverride: 12.5, reason: 'הצעה' }).success).toBe(true);
    expect(PatchBoqLineRequestSchema.safeParse({ priceOverride: null }).success).toBe(true);
    expect(PatchBoqLineRequestSchema.safeParse({ priceOverride: null, reason: 'x' }).success).toBe(false);
    expect(PatchBoqLineRequestSchema.safeParse({ priceOverride: -1 }).success).toBe(false);
    expect(PatchLibraryItemRequestSchema.safeParse({ price: 99 }).success).toBe(true);
    expect(PatchLibraryItemRequestSchema.safeParse({ price: null }).success).toBe(true);
    expect(BulkLibraryPriceRequestSchema.safeParse({ orgId: 'o', items: [{ itemId: 'a', amount: 1 }, { itemId: 'a', amount: 2 }] }).success).toBe(false);
    expect(BulkLibraryPriceRequestSchema.safeParse({ orgId: 'o', items: Array.from({ length: 501 }, (_, i) => ({ itemId: `i${i}`, amount: 1 })) }).success).toBe(false);
    expect(PatchProjectPricingRequestSchema.safeParse({ adjustmentPct: -10 }).success).toBe(true);
    expect(PatchProjectPricingRequestSchema.safeParse({ adjustmentPct: -91 }).success).toBe(false);
    expect(PatchOrgSettingsRequestSchema.safeParse({ vatRate: 0.17 }).success).toBe(true);
    expect(PatchOrgSettingsRequestSchema.safeParse({ vatRate: 0.6 }).success).toBe(false);
    expect(ExportBoqRequestSchema.parse({}).includePrices).toBe(true);
    expect(BoqDocumentQuerySchema.parse({ prices: '0' }).prices).toBe(false);
    expect(CreateShareLinkRequestSchema.parse({ label: 'x' }).showPrices).toBe(false);
  });

  it('priceOverride is API-written and preserved by every rebuild; derived fields are not stored', () => {
    for (const f of ['priceOverride', 'priceOverrideBy', 'priceOverrideAt', 'priceOverrideReason'] as const) {
      expect(BOQ_LINE_API_FIELDS).toContain(f);
      expect(BOQ_LINE_PRESERVED_FIELDS).toContain(f);
    }
    const out = applyRebuild({ status: 'draft', priceOverride: 42, priceOverrideBy: 'u', priceOverrideReason: 'r' }, { code: '4.10', qty: 3 });
    expect(out).toMatchObject({ priceOverride: 42, priceOverrideBy: 'u', priceOverrideReason: 'r', qty: 3 });
    expect(BOQ_LINE_DERIVED_FIELDS.some((f) => (BOQ_LINE_PRESERVED_FIELDS as readonly string[]).includes(f))).toBe(false);
  });

  it('price import: mode + flag on the request and the job (both optional on the job)', () => {
    expect(CreateLibraryImportRequestSchema.safeParse({ orgId: 'o', filename: 'a.xlsx', sizeBytes: 1, mode: 'prices', overwriteManualPrices: true }).success).toBe(true);
    expect(CreateLibraryImportRequestSchema.safeParse({ orgId: 'o', filename: 'a.xlsx', sizeBytes: 1, mode: 'other' }).success).toBe(false);
    const id = '6f9619ff-8b86-4d11-b42d-00c04fc964ff';
    const job = { schemaVersion: 1, type: 'library.import', jobId: 'j1', orgId: 'o1', projectId: null, importId: id, storagePath: `orgs/o1/imports/${id}.xlsx`, sourceKind: 'xlsx', traceparent: null };
    expect(LibraryImportJobSchema.safeParse(job).success).toBe(true);
    expect(LibraryImportJobSchema.safeParse({ ...job, mode: 'prices', overwriteManualPrices: false }).success).toBe(true);
  });
});

describe('Sprint 8 — planPriceImport (reference semantics for Worker-BOQ)', () => {
  const opts = (overwriteManual = false) => ({ overwriteManual, idFor: itemIdFor, normalize: normalizeDescription });
  const lib = [
    item('4.10', 'נקודת מאור', null),
    item('4.11', 'שקע', price(50, 'manual')),
    item('4.12', 'מפסק', price(30, 'import')),
    item('4.13', 'גוף תאורה שקוע', null),
    item('4.13', 'גוף תאורה צמוד', null),
    item('4.14', 'ישן', null, false),
  ];

  it('fills unpriced items, updates imported prices, reports unmatched / unchanged; never touches manual prices', () => {
    const { writes, report } = planPriceImport(
      lib,
      [
        { row: 2, code: '4.10', description: 'נקודת מאור', amount: 120 },
        { row: 3, code: '4.11', description: 'שקע', amount: 55 },
        { row: 4, code: '4.12', description: 'מפסק', amount: 35 },
        { row: 5, code: '9.99', description: 'לא קיים', amount: 1 },
        { row: 6, code: '4.14', description: 'ישן', amount: 7 },
        { row: 7, code: '4.11', description: 'שקע', amount: 55 },
      ],
      opts(),
    );
    expect(writes).toEqual([
      { itemId: itemIdFor('4.10', 'נקודת מאור'), amount: 120 },
      { itemId: itemIdFor('4.12', 'מפסק'), amount: 35 },
    ]);
    expect(report).toMatchObject({ rows: 6, matched: 4, applied: 2, unchanged: 0, unmatched: 2, conflicts: 1, skippedManual: 1, overwriteManualPrices: false });
    expect(report.unmatchedRows.map((r) => r.code)).toEqual(['9.99', '4.14']); // inactive items never match
    expect(report.conflictRows).toEqual([{ row: 3, code: '4.11', itemId: itemIdFor('4.11', 'שקע'), reason: 'manual_price', current: 50, incoming: 55 }]);
    expect(PriceImportReportSchema.safeParse(report).success).toBe(true);
  });

  it('overwriteManual replaces manual prices; equal prices are unchanged', () => {
    const { writes, report } = planPriceImport(lib, [{ row: 2, code: '4.11', description: 'x', amount: 60 }, { row: 3, code: '4.12', description: 'מפסק', amount: 30 }], opts(true));
    expect(writes).toEqual([{ itemId: itemIdFor('4.11', 'שקע'), amount: 60 }]);
    expect(report).toMatchObject({ applied: 1, unchanged: 1, conflicts: 0 });
  });

  it('several items of a code: resolved by id / description, else ambiguous; the same item with two prices → duplicate_in_file', () => {
    const { writes, report } = planPriceImport(
      lib,
      [
        { row: 2, code: '4.13', description: 'גוף תאורה שקוע', amount: 300 },
        { row: 3, code: '4.13', description: 'משהו אחר', amount: 310 },
        { row: 4, code: '4.10', description: 'נקודת מאור', amount: 100 },
        { row: 5, code: '4.10', description: 'נקודת מאור', amount: 110 },
      ],
      opts(),
    );
    expect(writes).toEqual([{ itemId: itemIdFor('4.13', 'גוף תאורה שקוע'), amount: 300 }]);
    expect(report.conflictRows.map((c) => [c.row, c.reason])).toEqual([
      [3, 'ambiguous_item'],
      [4, 'duplicate_in_file'],
      [5, 'duplicate_in_file'],
    ]);
    expect(report).toMatchObject({ matched: 3, applied: 1, conflicts: 3, skippedManual: 0 });
  });
});

describe('Sprint 8 — comparison + housekeeping contracts', () => {
  it('lines snapshot: path (never signable), shape, query defaults', () => {
    const p = storagePaths.boqLinesSnapshot('o1', 'p1', 'b1');
    expect(p).toBe('orgs/o1/projects/p1/boq/b1/lines.json.gz');
    expect(BOQ_LINES_SNAPSHOT_PATH_RE.test(p)).toBe(true);
    expect(ARTIFACT_PATH_RE.test(p)).toBe(false);
    const snap = { schema: 'kamutan.boq-lines/1', projectId: 'p1', buildId: 'b1', createdAt: '2026-11-07T10:00:00.000Z', sheetVersions: { s1: 'v1' }, lines: [{ lineId: 'l1', chapter: '04', code: '4.10', description: 'x', unit: "יח'", qty: 2, price: null, sourceVersions: [{ sheetId: 's1', versionId: 'v1' }] }] };
    expect(BoqLinesSnapshotSchema.safeParse(snap).success).toBe(true);
    expect(BoqLinesSnapshotSchema.safeParse({ ...snap, schema: 'x' }).success).toBe(false);
    expect(BoqCompareQuerySchema.parse({})).toEqual({ base: 'previous' });
    expect(BoqCompareQuerySchema.safeParse({ base: 'yesterday' }).success).toBe(false);
  });

  it('deletes: typed confirmation, revoke reason; sheet limit 100 with a Hebrew message and error code', () => {
    expect(deleteConfirmationMatches(' בית  נח ', 'בית נח')).toBe(true);
    expect(deleteConfirmationMatches('בית', 'בית נח')).toBe(false);
    expect(deleteConfirmationMatches('', '')).toBe(false);
    expect(DeleteProjectRequestSchema.safeParse({}).success).toBe(false);
    expect(SHARE_REVOKE_REASONS).toContain('sheet_set_deleted');
    expect(MAX_SHEETS_PER_PROJECT).toBe(100);
    expect([exceedsSheetLimit(99, 1), exceedsSheetLimit(100, 1), exceedsSheetLimit(90, 11)]).toEqual([false, true, true]);
    expect(sheetLimitMessageHe(100)).toMatch(/100 גיליונות/);
    expect(API_ERROR_CODES).toContain('sheet_limit');
    expect(UPLOAD_ERROR_MESSAGES_HE.sheet_limit).toMatch(/100/);
  });

  it('registry exports the Sprint 8 schemas for the worker', () => {
    for (const n of ['ItemPrice', 'BoqTotals', 'PriceImportReport', 'BoqLinesSnapshot', 'BoqComparison', 'BulkLibraryPriceRequest', 'DeleteProjectRequest', 'DeleteSheetSetResponse']) expect(jsonSchemaRegistry).toHaveProperty(n);
  });
});

describe('Sprint 8 integration (web)', () => {
  it('dry run only with mode prices; apply request defaults; builds list query; report planned rows', () => {
    expect(CreateLibraryImportRequestSchema.safeParse({ orgId: 'o', filename: 'a.xlsx', sizeBytes: 1, mode: 'prices', dryRun: true }).success).toBe(true);
    expect(CreateLibraryImportRequestSchema.safeParse({ orgId: 'o', filename: 'a.xlsx', sizeBytes: 1, dryRun: true }).success).toBe(false);
    expect(ApplyImportPricesRequestSchema.parse({ orgId: 'o' })).toEqual({ orgId: 'o', overwriteItemIds: [] });
    expect(BoqBuildListQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(BoqBuildListQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(BoqBuildSummarySchema.safeParse({ buildId: 'b', status: 'succeeded', trigger: null, createdAt: null, finishedAt: null, lineCount: 3, hasSnapshot: true, exportedAt: null, exportId: null, latest: true }).success).toBe(true);
    const rep = { rows: 1, matched: 1, applied: 0, unchanged: 0, unmatched: 0, conflicts: 0, skippedManual: 0, overwriteManualPrices: false, dryRun: true, unmatchedRows: [], conflictRows: [], planned: [{ itemId: 'it1', code: '4.10', amount: 5, current: null, currentSource: null }] };
    expect(PriceImportReportSchema.safeParse(rep).success).toBe(true);
    const job = { schemaVersion: 1, type: 'library.import', jobId: 'j1', orgId: 'o1', projectId: null, importId: '6f9619ff-8b86-4d11-b42d-00c04fc964ff', storagePath: 'orgs/o1/imports/6f9619ff-8b86-4d11-b42d-00c04fc964ff.xlsx', sourceKind: 'xlsx', traceparent: null, mode: 'prices', dryRun: true };
    expect(LibraryImportJobSchema.safeParse(job).success).toBe(true);
    const p = { id: 'p', orgId: 'o', name: 'x', floors: [], status: 'active', createdBy: 'u', createdAt: '2026-11-07T00:00:00.000Z', sheetCount: 3, sheetLimit: 100 };
    expect(ProjectSchema.parse(p)).toMatchObject({ sheetCount: 3, sheetLimit: 100 });
  });
});
