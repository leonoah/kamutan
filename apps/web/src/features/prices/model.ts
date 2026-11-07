import type { BoqLine, BoqTotals, LibraryItem, PriceImportReport, Role } from "@/api/types";
import { VAT_RATE_DEFAULT } from "@/api/types";
import { effectiveQty } from "@/features/boq/model";

/**
 * Sprint 8 — prices and totals on the client (pure). The API is the source (contracts prices.ts): every line DTO
 * carries the DERIVED `unitPrice` (effective: `priceOverride` ?? library price), `unitPriceSource` and `lineTotal`;
 * `GET boq` carries `summary.totals` (contracts BoqTotals). These helpers read those fields, and compute the same
 * numbers (contracts `computeBoqTotals` semantics) only for subsets the API does not total (hub sheet filter, chapter
 * subtotals) and for optimistic updates.
 */

/** 1e-6 money rounding like contracts `roundMoney` (float noise only). */
export const roundMoney = (x: number): number => Math.round(x * 1e6) / 1e6;
/** Display / input rounding to agorot. */
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

type Priced = Pick<BoqLine, "unitPrice" | "priceOverride">;

/** The unit price the line is priced with (API `unitPrice`; a line not yet priced by the API falls back to its override). */
export const effectivePrice = (l: Priced): number | null =>
  l.unitPrice !== undefined ? l.unitPrice : typeof l.priceOverride === "number" ? l.priceOverride : null;
export const isPriceOverridden = (l: Pick<BoqLine, "priceOverride">): boolean => typeof l.priceOverride === "number";
export const isUnpriced = (l: Priced): boolean => effectivePrice(l) === null;

const pricedQty = (l: Pick<BoqLine, "qty" | "qtyOverride" | "needsInput">) =>
  l.needsInput && (l.qtyOverride === null || l.qtyOverride === undefined) ? 0 : effectiveQty(l);

/** contracts `lineTotal(qty, price)`: null without a price; a line still "להשלמה ידנית" counts qty 0. */
export function lineTotal(l: Priced & Pick<BoqLine, "qty" | "qtyOverride" | "needsInput" | "lineTotal">): number | null {
  if (l.lineTotal !== undefined && l.unitPrice !== undefined) return l.lineTotal;
  const p = effectivePrice(l);
  return p === null ? null : roundMoney(pricedQty(l) * p);
}

export const sumTotals = (lines: readonly Parameters<typeof lineTotal>[0][]): number => roundMoney(lines.reduce((s, l) => s + (lineTotal(l) ?? 0), 0));

export interface PricingSettings {
  /** 0.18 = 18%. */
  vatRate: number;
  /** −5 = 5% discount, +10 = 10% markup; 0 / null = none. */
  adjustmentPct: number | null;
}

/** contracts `computeBoqTotals` over a set of lines (same field names as BoqTotals). */
export function totalsOf(lines: readonly BoqLine[], s: Partial<PricingSettings> = {}): BoqTotals {
  const vatRate = s.vatRate ?? VAT_RATE_DEFAULT;
  const pct = s.adjustmentPct ?? 0;
  const linesTotal = sumTotals(lines);
  const adjustment = roundMoney((linesTotal * pct) / 100);
  const beforeVat = roundMoney(linesTotal + adjustment);
  const vat = roundMoney(beforeVat * vatRate);
  const unpricedLines = lines.filter(isUnpriced).length;
  return { currency: "ILS", linesTotal, adjustmentPct: pct, adjustment, beforeVat, vat, afterVat: roundMoney(beforeVat + vat), vatRate, pricedLines: lines.length - unpricedLines, unpricedLines };
}

/* ---------------- formatting / parsing ---------------- */

const nf2 = new Intl.NumberFormat("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** "₪ 1,234.50" (he-IL grouping, always 2 decimals); null → "" (an empty cell). */
export const formatMoney = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? "" : `₪ ${nf2.format(round2(n))}`);
/** Signed amount for deltas / discounts: "+₪ 120.00", "−₪ 45.50" (true minus sign). */
export const formatMoneyDelta = (n: number): string => (round2(n) === 0 ? formatMoney(0) : `${n > 0 ? "+" : "−"}${formatMoney(Math.abs(n))}`);
/** "18%" / "7.5%". */
export const formatPct = (n: number): string => `${Number.isInteger(n) ? n : round2(n)}%`;

/** contracts PRICE_MAX (₪). */
export const PRICE_MAX = 100_000_000;
/** contracts PRICE_ADJUSTMENT_MIN_PCT / MAX_PCT. */
export const ADJUSTMENT_MIN_PCT = -90;
export const ADJUSTMENT_MAX_PCT = 200;

/**
 * A price typed by a person: "1,234.5", "₪ 80", "80.00". Returns null for empty, NaN for invalid (negative, more than
 * 2 decimals, above PRICE_MAX).
 */
export function parseMoney(input: string): number | null {
  const s = input.replace(/[₪\s,‎‏]/g, "");
  if (!s) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return Number.NaN;
  const n = Number(s);
  return n > PRICE_MAX ? Number.NaN : n;
}
/** A percent typed by a person, within [min, max] with ≤ 2 decimals; empty = null. */
export function parsePct(input: string, min = ADJUSTMENT_MIN_PCT, max = ADJUSTMENT_MAX_PCT): number | null {
  const s = input.replace(/[%\s‎‏]/g, "").replace(/^[−–]/, "-");
  if (!s) return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return Number.NaN;
  const n = Number(s);
  return n < min || n > max ? Number.NaN : n;
}

/* ---------------- roles ---------------- */

/** Price list, line prices, project discount: editor+ (API: library edit role / `priceOverride` / `boq/pricing`). */
export const canEditPrices = (role: Role | null | undefined): boolean => role === "admin" || role === "editor";

/* ---------------- library bulk edit ---------------- */

export type BulkPriceMode = { kind: "set"; amount: number } | { kind: "pct"; pct: number } | { kind: "clear" };

/** The bulk edit's new amount per selected item (percent changes skip items without a price). */
export function bulkPlanPrices(items: readonly Pick<LibraryItem, "id" | "price">[], mode: BulkPriceMode): { itemId: string; amount: number | null }[] {
  const out: { itemId: string; amount: number | null }[] = [];
  for (const i of items) {
    if (mode.kind === "set") out.push({ itemId: i.id, amount: round2(mode.amount) });
    else if (mode.kind === "clear") {
      if (i.price) out.push({ itemId: i.id, amount: null });
    } else if (i.price) out.push({ itemId: i.id, amount: Math.min(PRICE_MAX, Math.max(0, round2(i.price.amount * (1 + mode.pct / 100)))) });
  }
  return out;
}

/* ---------------- price import review (contracts PriceImportReport) ---------------- */

/** Conflicts the user may decide (a MANUAL price vs the file); duplicates / ambiguous rows are never written. */
export const manualConflicts = (r: PriceImportReport) => r.conflictRows.filter((c) => c.reason === "manual_price" && c.itemId);

/** What apply-prices will write: every planned item + the manual conflicts chosen for overwrite. */
export function importApplyCounts(r: PriceImportReport, overwrite: ReadonlySet<string>) {
  const manual = manualConflicts(r);
  const over = manual.filter((c) => overwrite.has(c.itemId!)).length;
  return { fill: r.planned?.length ?? r.applied, overwrite: over, keep: manual.length - over, unmatched: r.unmatched, other: r.conflicts - manual.length };
}

/* ---------------- optimistic line patch ---------------- */

/** Setting an override prices the line at once; a restore waits for the server (the library price is not on the line). */
export function applyPriceOverride(l: BoqLine, amount: number | null, reason: string | null, uid: string | null, at = new Date().toISOString()): BoqLine {
  if (amount === null) return { ...l, priceOverride: null, priceOverrideBy: null, priceOverrideAt: null, priceOverrideReason: null };
  const next: BoqLine = { ...l, priceOverride: amount, priceOverrideBy: uid, priceOverrideAt: at, priceOverrideReason: reason, unitPrice: amount, unitPriceSource: "override" };
  return { ...next, lineTotal: roundMoney(pricedQty(next) * amount) };
}
