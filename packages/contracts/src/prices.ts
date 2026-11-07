/**
 * Sprint 8 — prices and totals (docs/agents/SPRINT8_BRIEF.md §1).
 *
 *  - Org price list: `itemLibrary/{itemId}.price` (`ItemPrice`), editor+ (PATCH item / bulk), audited.
 *  - Price import: the library import job with `mode: 'prices'` (Worker-BOQ parses the price column); reference
 *    semantics = `planPriceImport` (never overwrites a MANUAL price unless `overwriteManualPrices`).
 *  - Project overrides: `BoqLine.priceOverride` (+By/At/Reason, preserved by every rebuild) and the project-level
 *    discount / markup `Project.pricing.adjustmentPct`.
 *  - Totals: line total = effective qty × effective unit price; chapter subtotals; lines total → discount / markup →
 *    before VAT → VAT (org `vatRate`, default 0.18) → after VAT (`computeBoqTotals`). Lines without a price are flagged
 *    ("ללא מחיר", warning kind `unpriced`) and count as 0 — the export still works.
 *
 * Money is ILS (₪) only. Amounts are stored as given (no rounding); totals are rounded to 1e-6 (float noise only) so the
 * xlsx formulas evaluate to the same numbers as the model.
 */
import { z } from 'zod';
import { TimestampSchema } from './common.js';
import { DocIdSchema, UidSchema } from './org.js';
import type { ItemLibraryItem } from './library.js';

export const CURRENCIES = ['ILS'] as const;
export const CurrencySchema = z.enum(CURRENCIES);
/** Largest unit price accepted anywhere (₪). */
export const PRICE_MAX = 100_000_000;
export const PriceAmountSchema = z.number().finite().min(0).max(PRICE_MAX);

export const PRICE_SOURCES = ['manual', 'import'] as const;
export const PriceSourceSchema = z.enum(PRICE_SOURCES);
export type PriceSource = z.infer<typeof PriceSourceSchema>;

/** orgs/{o}/itemLibrary/{itemId}.price — absent / null = the item has no price. */
export const ItemPriceSchema = z.object({
  amount: PriceAmountSchema,
  currency: CurrencySchema,
  updatedAt: TimestampSchema.nullable(),
  /** Who set it (manual: the editor; import: the uploader of the import). */
  by: UidSchema.nullable(),
  source: PriceSourceSchema,
  /** libraryImports/{id} that wrote it (source `import`). */
  importId: z.string().uuid().nullable().optional(),
});
export type ItemPrice = z.infer<typeof ItemPriceSchema>;

/** Hebrew marker of a line / item without a price (BOQ panel, preview, Excel note, warnings). */
export const NO_PRICE_HE = 'ללא מחיר';
/** Marker of a project price override ("✎ מחיר ידני"). */
export const PRICE_OVERRIDE_HE = 'מחיר ידני';
export const CURRENCY_SYMBOL = '₪';

/** 1e-6 rounding of money (float noise only — the xlsx formulas compute the same values). */
export const roundMoney = (x: number): number => Math.round(x * 1e6) / 1e6;

// ---------------------------------------------------------------------------
// Line price resolution
// ---------------------------------------------------------------------------

/** Where a line's unit price comes from: the project override, the org library, or nowhere (null). */
export const LINE_PRICE_SOURCES = ['override', 'library'] as const;
export const LinePriceSourceSchema = z.enum(LINE_PRICE_SOURCES);
export type LinePriceSource = z.infer<typeof LinePriceSourceSchema>;

type PricedItem = Pick<ItemLibraryItem, 'id' | 'code' | 'description' | 'active'> & { price?: ItemPrice | null | undefined };

/**
 * The org library price of a BOQ line (reference semantics; the worker's lines snapshot uses the same):
 *  1. the item whose id is `itemIdFor(code, line.description)` when it is active and priced;
 *  2. else the active priced items of the code — the most recently updated price (ties: smaller id).
 * Inactive items never price a line. `idFor` = `itemIdFor` (injected to keep this module free of the library import).
 */
export function libraryPriceFor(
  line: { code: string; description: string },
  items: readonly PricedItem[],
  idFor: (code: string, description: string) => string,
): { amount: number; itemId: string } | null {
  const ofCode = items.filter((i) => i.active && i.code === line.code && i.price && Number.isFinite(i.price.amount));
  if (ofCode.length === 0) return null;
  const exactId = idFor(line.code, line.description);
  const exact = ofCode.find((i) => i.id === exactId);
  const pick =
    exact ??
    [...ofCode].sort((a, b) => {
      const ta = Date.parse(a.price?.updatedAt ?? '') || 0;
      const tb = Date.parse(b.price?.updatedAt ?? '') || 0;
      return tb - ta || a.id.localeCompare(b.id);
    })[0];
  return pick && pick.price ? { amount: pick.price.amount, itemId: pick.id } : null;
}

/** Effective unit price: the line's `priceOverride` wins, else the library price, else null ("ללא מחיר"). */
export function effectivePrice(line: { priceOverride?: number | null | undefined }, libraryPrice: number | null | undefined): { price: number | null; source: LinePriceSource | null } {
  if (typeof line.priceOverride === 'number' && Number.isFinite(line.priceOverride)) return { price: line.priceOverride, source: 'override' };
  if (typeof libraryPrice === 'number' && Number.isFinite(libraryPrice)) return { price: libraryPrice, source: 'library' };
  return { price: null, source: null };
}

/** Line total = qty × price (null when the line has no price; a null qty — "להשלמה ידנית" — counts as 0). */
export const lineTotal = (qty: number | null, price: number | null): number | null => (price === null ? null : roundMoney((qty ?? 0) * price));

// ---------------------------------------------------------------------------
// Project discount / markup + totals
// ---------------------------------------------------------------------------

export const PRICE_ADJUSTMENT_MIN_PCT = -90;
export const PRICE_ADJUSTMENT_MAX_PCT = 200;

/** Project doc field `pricing` (API-written, `PATCH /v1/projects/:pid/boq/pricing`, editor+, audited). */
export const ProjectPricingSchema = z.object({
  /** Discount (< 0) or markup (> 0) in percent applied to the lines total before VAT; 0 = none. */
  adjustmentPct: z.number().finite().min(PRICE_ADJUSTMENT_MIN_PCT).max(PRICE_ADJUSTMENT_MAX_PCT),
  updatedBy: UidSchema.nullable(),
  updatedAt: TimestampSchema.nullable(),
});
export type ProjectPricing = z.infer<typeof ProjectPricingSchema>;

/** PATCH /v1/projects/:pid/boq/pricing (editor+): `adjustmentPct: null` (or 0) removes the discount / markup. */
export const PatchProjectPricingRequestSchema = z
  .object({ adjustmentPct: z.number().finite().min(PRICE_ADJUSTMENT_MIN_PCT).max(PRICE_ADJUSTMENT_MAX_PCT).nullable() })
  .strict();
export type PatchProjectPricingRequest = z.infer<typeof PatchProjectPricingRequestSchema>;
export const PatchProjectPricingResponseSchema = z.object({ projectId: DocIdSchema, pricing: ProjectPricingSchema });
export type PatchProjectPricingResponse = z.infer<typeof PatchProjectPricingResponseSchema>;

/** "הנחה 5%" / "תוספת 12.5%" (Excel row label, preview, hub). */
export const adjustmentLabelHe = (pct: number): string => `${pct < 0 ? 'הנחה' : 'תוספת'} ${String(Math.abs(Math.round(pct * 100) / 100))}%`;
/** "מע"מ 18%" */
export const vatLabelHe = (rate: number): string => `מע"מ ${String(Math.round(rate * 10000) / 100)}%`;

/**
 * Totals of a BOQ (BoqDocumentModel, GET boq summary, share snapshot with prices):
 * linesTotal = Σ line totals (unpriced lines count 0); adjustment = linesTotal × adjustmentPct / 100;
 * beforeVat = linesTotal + adjustment; vat = beforeVat × vatRate; afterVat = beforeVat + vat.
 */
export const BoqTotalsSchema = z.object({
  currency: CurrencySchema,
  linesTotal: z.number().finite(),
  adjustmentPct: z.number().finite(),
  adjustment: z.number().finite(),
  beforeVat: z.number().finite(),
  vat: z.number().finite(),
  afterVat: z.number().finite(),
  vatRate: z.number().min(0).max(1),
  /** Lines with an effective price / without one (the "ללא מחיר" warning count). */
  pricedLines: z.number().int().nonnegative(),
  unpricedLines: z.number().int().nonnegative(),
});
export type BoqTotals = z.infer<typeof BoqTotalsSchema>;

export function computeBoqTotals(input: { linesTotal: number; adjustmentPct?: number | null | undefined; vatRate: number; pricedLines: number; unpricedLines: number }): BoqTotals {
  const linesTotal = roundMoney(input.linesTotal);
  const pct = typeof input.adjustmentPct === 'number' && Number.isFinite(input.adjustmentPct) ? input.adjustmentPct : 0;
  const adjustment = roundMoney((linesTotal * pct) / 100);
  const beforeVat = roundMoney(linesTotal + adjustment);
  const vat = roundMoney(beforeVat * input.vatRate);
  return { currency: 'ILS', linesTotal, adjustmentPct: pct, adjustment, beforeVat, vat, afterVat: roundMoney(beforeVat + vat), vatRate: input.vatRate, pricedLines: input.pricedLines, unpricedLines: input.unpricedLines };
}

// ---------------------------------------------------------------------------
// Library prices: PATCH item `price` + bulk edit
// ---------------------------------------------------------------------------

export const LIBRARY_PRICE_BULK_MAX = 500;

/** POST /v1/library/prices (editor+, strict rate limit): set (number) or clear (null) the price of up to 500 items. */
export const BulkLibraryPriceRequestSchema = z
  .object({
    orgId: DocIdSchema,
    items: z
      .array(z.object({ itemId: DocIdSchema, amount: PriceAmountSchema.nullable() }).strict())
      .min(1)
      .max(LIBRARY_PRICE_BULK_MAX)
      .refine((xs) => new Set(xs.map((x) => x.itemId)).size === xs.length, { message: 'duplicate item ids' }),
  })
  .strict();
export type BulkLibraryPriceRequest = z.infer<typeof BulkLibraryPriceRequestSchema>;

export const BULK_PRICE_SKIP_REASONS = ['not_found', 'unchanged'] as const;
export const BulkLibraryPriceResponseSchema = z.object({
  /** Shared by the audit events of this call (`itemLibrary/update {price, batchId}`). */
  batchId: z.string().min(1).max(64),
  updated: z.array(z.object({ itemId: DocIdSchema, code: z.string(), from: z.number().nullable(), to: z.number().nullable() })),
  skipped: z.array(z.object({ itemId: DocIdSchema, reason: z.enum(BULK_PRICE_SKIP_REASONS) })),
});
export type BulkLibraryPriceResponse = z.infer<typeof BulkLibraryPriceResponseSchema>;

// ---------------------------------------------------------------------------
// Price import (library import job, `mode: 'prices'`)
// ---------------------------------------------------------------------------

/** `library` (Sprint 3: items + template; Sprint 8: + prices when the file has a price column) or `prices` (prices only). */
export const LIBRARY_IMPORT_MODES = ['library', 'prices'] as const;
export const LibraryImportModeSchema = z.enum(LIBRARY_IMPORT_MODES);
export type LibraryImportMode = z.infer<typeof LibraryImportModeSchema>;

/** One priced row the worker read from the file (1-based sheet row; code as TEXT). */
export interface PriceImportRow {
  row: number;
  code: string;
  description: string;
  amount: number;
}

export const PRICE_CONFLICT_REASONS = ['manual_price', 'duplicate_in_file', 'ambiguous_item'] as const;
export const PriceConflictReasonSchema = z.enum(PRICE_CONFLICT_REASONS);
/** Hebrew reasons (import report). */
export const PRICE_CONFLICT_REASON_HE: Readonly<Record<z.infer<typeof PriceConflictReasonSchema>, string>> = Object.freeze({
  manual_price: 'קיים מחיר שהוזן ידנית – לא נדרס',
  duplicate_in_file: 'הסעיף מופיע בקובץ כמה פעמים עם מחירים שונים',
  ambiguous_item: 'לסעיף כמה פריטים בספרייה ולא ניתן לקבוע לאיזה מהם',
});

export const PRICE_REPORT_ROWS_MAX = 500;
/** Integration: `planned` rows of a dry-run report (= the library cap). */
export const PRICE_PLANNED_ROWS_MAX = 5000;
const ReportCode = z.string().max(64);
/** `LibraryImport.stats.prices` — written by Worker-BOQ (mode `prices`, or `library` with a price column). */
export const PriceImportReportSchema = z
  .object({
    /** Rows with an item code and a price. */
    rows: z.number().int().nonnegative(),
    /** Rows resolved to a library item (applied + unchanged + manual conflicts + duplicates of a resolved item). */
    matched: z.number().int().nonnegative(),
    /** Items whose price was written (new or changed). */
    applied: z.number().int().nonnegative(),
    /** Rows whose item already had exactly this price. */
    unchanged: z.number().int().nonnegative(),
    unmatched: z.number().int().nonnegative(),
    conflicts: z.number().int().nonnegative(),
    /** Conflicts of reason `manual_price` (subset of `conflicts`). */
    skippedManual: z.number().int().nonnegative(),
    overwriteManualPrices: z.boolean(),
    unmatchedRows: z.array(z.object({ row: z.number().int().positive(), code: ReportCode, description: z.string().max(300), amount: z.number().finite() })).max(PRICE_REPORT_ROWS_MAX),
    /**
     * Integration (dry run, Worker-BOQ): every item the plan WOULD write (= `PriceImportPlan.writes` with the item's
     * current price). `POST …/apply-prices` writes exactly these + the `manual_price` conflicts the user chose.
     */
    planned: z
      .array(z.object({ itemId: DocIdSchema, code: ReportCode, amount: z.number().finite(), current: z.number().finite().nullable(), currentSource: PriceSourceSchema.nullable() }))
      .max(PRICE_PLANNED_ROWS_MAX)
      .optional(),
    /** Integration: true when nothing was written (job `dryRun`); the prices wait for `apply-prices`. */
    dryRun: z.boolean().optional(),
    conflictRows: z
      .array(
        z.object({
          row: z.number().int().positive(),
          code: ReportCode,
          itemId: DocIdSchema.nullable(),
          reason: PriceConflictReasonSchema,
          current: z.number().finite().nullable(),
          incoming: z.number().finite(),
        }),
      )
      .max(PRICE_REPORT_ROWS_MAX),
  })
  .passthrough();
export type PriceImportReport = z.infer<typeof PriceImportReportSchema>;

// ---------------------------------------------------------------------------
// Integration: review before writing (dry run → apply)
// ---------------------------------------------------------------------------

/**
 * POST /v1/library/imports/:importId/apply-prices (editor+) — only for a SUCCEEDED `dryRun` import with
 * `stats.prices.planned`, once (409 when already applied / not a dry run / not finished). Writes every `planned` item +
 * the `manual_price` conflicts whose `itemId` is listed in `overwriteItemIds` (per-item explicit choice); duplicates /
 * ambiguous rows are never written. Each item is RE-CHECKED at apply time: gone / inactive → skipped `not_found`; its
 * price became manual since the dry run and it is not listed → kept (`manual_kept`); same price → `unchanged`.
 */
export const ApplyImportPricesRequestSchema = z
  .object({ orgId: DocIdSchema, overwriteItemIds: z.array(DocIdSchema).max(PRICE_PLANNED_ROWS_MAX).default([]) })
  .strict();
export type ApplyImportPricesRequest = z.infer<typeof ApplyImportPricesRequestSchema>;
export const APPLY_PRICE_SKIP_REASONS = ['not_found', 'unchanged', 'manual_kept'] as const;
export const ApplyImportPricesResponseSchema = z.object({
  importId: z.string().uuid(),
  /** Items written (incl. `overwritten`). */
  applied: z.number().int().nonnegative(),
  /** Manual prices replaced (listed in `overwriteItemIds`). */
  overwritten: z.number().int().nonnegative(),
  /** Manual-price conflicts left as they were (not listed). */
  kept: z.number().int().nonnegative(),
  skipped: z.array(z.object({ itemId: DocIdSchema, reason: z.enum(APPLY_PRICE_SKIP_REASONS) })),
  appliedAt: TimestampSchema,
});
export type ApplyImportPricesResponse = z.infer<typeof ApplyImportPricesResponseSchema>;

export interface PriceImportPlan {
  /** Item prices to write (`source: 'import'`, `importId`, `by` = the import's uploader). */
  writes: Array<{ itemId: string; amount: number }>;
  report: PriceImportReport;
}

/**
 * Reference semantics of a price import (Worker-BOQ mirrors it; the API's tests pin it):
 *  1. Resolve each row among the ACTIVE items of its code (exact TEXT, trimmed): none → `unmatched`; one → it; several →
 *     the item `itemIdFor(code, description)`, else the one whose normalised description equals the row's, else
 *     conflict `ambiguous_item`.
 *  2. Rows resolved to the same item with different amounts → every such row is a `duplicate_in_file` conflict (no
 *     write); equal amounts count once.
 *  3. Current price equal → `unchanged`. Current price `source: 'manual'` → conflict `manual_price` (not written)
 *     unless `overwriteManual`. Otherwise → write (`applied`).
 * Never creates items (mode `library` creates them first, then prices them with this plan).
 */
export function planPriceImport(
  items: readonly PricedItem[],
  rows: readonly PriceImportRow[],
  opts: { overwriteManual: boolean; idFor: (code: string, description: string) => string; normalize: (s: string) => string },
): PriceImportPlan {
  const byCode = new Map<string, PricedItem[]>();
  for (const i of items) if (i.active) (byCode.get(i.code.trim()) ?? byCode.set(i.code.trim(), []).get(i.code.trim()))!.push(i);
  const report: PriceImportReport = { rows: rows.length, matched: 0, applied: 0, unchanged: 0, unmatched: 0, conflicts: 0, skippedManual: 0, overwriteManualPrices: opts.overwriteManual, unmatchedRows: [], conflictRows: [] };
  const conflict = (r: PriceImportRow, itemId: string | null, reason: z.infer<typeof PriceConflictReasonSchema>, current: number | null) => {
    report.conflicts++;
    if (reason === 'manual_price') report.skippedManual++;
    if (report.conflictRows.length < PRICE_REPORT_ROWS_MAX) report.conflictRows.push({ row: r.row, code: r.code.slice(0, 64), itemId, reason, current, incoming: r.amount });
  };
  const resolved = new Map<string, { item: PricedItem; rows: PriceImportRow[] }>();
  for (const r of rows) {
    const code = r.code.trim();
    const cands = byCode.get(code) ?? [];
    let item: PricedItem | undefined;
    if (cands.length === 1) item = cands[0];
    else if (cands.length > 1) {
      const id = opts.idFor(code, r.description);
      item = cands.find((c) => c.id === id) ?? cands.find((c) => opts.normalize(c.description) === opts.normalize(r.description));
      if (!item) {
        conflict(r, null, 'ambiguous_item', null);
        continue;
      }
    }
    if (!item) {
      report.unmatched++;
      if (report.unmatchedRows.length < PRICE_REPORT_ROWS_MAX) report.unmatchedRows.push({ row: r.row, code: code.slice(0, 64), description: r.description.slice(0, 300), amount: r.amount });
      continue;
    }
    report.matched++;
    const slot = resolved.get(item.id) ?? resolved.set(item.id, { item, rows: [] }).get(item.id)!;
    slot.rows.push(r);
  }
  const writes: PriceImportPlan['writes'] = [];
  for (const { item, rows: rs } of resolved.values()) {
    const current = item.price ? item.price.amount : null;
    if (new Set(rs.map((r) => r.amount)).size > 1) {
      for (const r of rs) conflict(r, item.id, 'duplicate_in_file', current);
      continue;
    }
    const r = rs[0] as PriceImportRow;
    if (current !== null && current === r.amount) {
      report.unchanged += rs.length;
      continue;
    }
    if (item.price?.source === 'manual' && !opts.overwriteManual) {
      conflict(r, item.id, 'manual_price', current);
      continue;
    }
    writes.push({ itemId: item.id, amount: r.amount });
    report.applied++;
  }
  return { writes, report };
}
