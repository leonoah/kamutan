import {
  computeBoqTotals,
  effectivePrice,
  effectiveQty,
  itemIdFor,
  libraryPriceFor,
  lineTotal,
  vatRateOf,
  type BoqLine,
  type BoqTotals,
  type ItemLibraryItem,
  type OrgSettings,
  type Project,
} from '@kamutan/contracts';

/**
 * Sprint 8: effective prices of BOQ lines (`priceOverride` ?? org library price) and the totals. Prices are resolved
 * on READ (GET boq, document, export, share snapshot) — a library price edit needs no rebuild. The derived fields
 * (`unitPrice`, `unitPriceSource`, `lineTotal`) are never stored.
 */

/** Effective quantity counted in money: a "להשלמה ידנית" line without an override has no quantity yet → 0. */
export const pricedQty = (l: BoqLine): number => (l.needsInput === true && (l.qtyOverride === null || l.qtyOverride === undefined) ? 0 : effectiveQty(l));

/** Active items grouped by code (library price lookup). */
export function itemsByCode(items: readonly ItemLibraryItem[]): Map<string, ItemLibraryItem[]> {
  const m = new Map<string, ItemLibraryItem[]>();
  for (const i of items) {
    if (!i.active || !i.price) continue;
    const arr = m.get(i.code) ?? [];
    arr.push(i);
    m.set(i.code, arr);
  }
  return m;
}

/** The line with `unitPrice`, `unitPriceSource`, `lineTotal` filled in. */
export function priceLine(l: BoqLine, byCode: ReadonlyMap<string, readonly ItemLibraryItem[]>): BoqLine {
  const lib = libraryPriceFor(l, byCode.get(l.code) ?? [], itemIdFor);
  const { price, source } = effectivePrice(l, lib?.amount ?? null);
  return { ...l, unitPrice: price, unitPriceSource: source, lineTotal: lineTotal(pricedQty(l), price) };
}

export function priceLines(lines: readonly BoqLine[], items: readonly ItemLibraryItem[]): BoqLine[] {
  const byCode = itemsByCode(items);
  return lines.map((l) => priceLine(l, byCode));
}

/** Totals over priced lines (project discount / markup, org VAT). */
export function totalsOf(lines: readonly BoqLine[], project: Pick<Project, 'pricing'> | null | undefined, settings: Pick<OrgSettings, 'vatRate'> | null | undefined): BoqTotals {
  let sum = 0;
  let priced = 0;
  for (const l of lines) {
    if (typeof l.unitPrice === 'number') {
      priced++;
      sum += l.lineTotal ?? 0;
    }
  }
  return computeBoqTotals({ linesTotal: sum, adjustmentPct: project?.pricing?.adjustmentPct ?? 0, vatRate: vatRateOf(settings), pricedLines: priced, unpricedLines: lines.length - priced });
}
