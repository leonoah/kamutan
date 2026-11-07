import {
  BOQ_COMPARE_SCHEMA,
  BOQ_LINES_SNAPSHOT_SCHEMA,
  lineTotal as contractLineTotal,
  planPriceImport,
  roundMoney,
  type BoqLinesSnapshot,
  type BoqLinesSnapshotLine,
  type PriceImportRow,
} from "@kamutan/contracts";
import type { BoqCompareCause, BoqCompareItem, BoqComparison, BoqLine, LibraryItem, PriceImportReport, SheetRow } from "./types";
import { compareCodes } from "@/features/boq/model";
import { lineDescription } from "@/features/boq/sprint7";
import { sheetName } from "@/features/sheets/model";

/**
 * Sprint 8 mock — stand-in for the API / Worker-BOQ parts of prices and comparison, in the CONTRACT shapes
 * (`@kamutan/contracts` prices.ts / compare.ts; the reference functions `planPriceImport`, `lineTotal`, `roundMoney`
 * are used as is, so the mock cannot drift from them):
 *  - a seeded org price list (deterministic per code; a few codes unpriced; 4.01 a MANUAL price → import conflicts);
 *  - `kamutan.boq-lines/1` snapshots per build + `kamutan.boq-compare/1` comparisons (causes: sheet versions,
 *    qty / price overrides, library price);
 *  - the price import as the worker runs it (`planPriceImport`, `overwriteManualPrices`);
 *  - "תוספות ושינויים" as a real spreadsheet (SpreadsheetML 2003 `.xls`) so the download is testable.
 */

/** Codes the demo leaves without a price ("ללא מחיר"): the warning count is visible on every screen. */
export const UNPRICED_DEMO_CODES = new Set(["4.17", "4.18", "9.03", "8.04", "7.07"]);
/** One demo price set by hand (so a price import shows a `manual_price` conflict). */
export const MANUAL_DEMO_CODE = "4.01";

/** Deterministic demo unit price (ILS) per code: chapter base × a code-dependent factor, 2 decimals. */
export function seedPriceFor(code: string, unit: string): number | null {
  if (UNPRICED_DEMO_CODES.has(code)) return null;
  const [ch = "0", n = "0"] = code.split(".");
  const base: Record<string, number> = { "01": 85, "02": 140, "03": 420, "04": 165, "05": 190, "06": 260, "07": 210, "08": 340, "09": 95 };
  const b = base[ch.padStart(2, "0")] ?? 120;
  const k = 0.75 + ((Number(n) * 37) % 50) / 100;
  const m2 = /מ"ר|מ״ר|m2/.test(unit) ? 1.4 : /קומפלט|קומפ/.test(unit) ? 6 : 1;
  return Math.round(b * k * m2 * 100) / 100;
}

export function seedLibraryPrices(items: Iterable<LibraryItem>, at: string) {
  for (const i of items) {
    if (i.price !== undefined) continue;
    const seed = seedPriceFor(i.code, i.unit);
    // the manual demo price was negotiated down (so a price import of the list price conflicts with it)
    const manual = i.code === MANUAL_DEMO_CODE;
    const amount = seed === null ? null : manual ? Math.round(seed * 92) / 100 : seed;
    i.price = amount === null ? null : { amount, currency: "ILS", updatedAt: at, by: "mock-user", source: manual ? "manual" : "import", importId: null };
  }
}

/* ---------------- line prices (API pricing.ts semantics) ---------------- */

/** The library price of a line: the active priced item of its code (most recently priced). */
export function libraryPriceOf(code: string, items: Iterable<LibraryItem>): number | null {
  let best: LibraryItem | null = null;
  for (const i of items)
    if (i.active && i.code === code && i.price && (!best || (i.price.updatedAt ?? "") > (best.price!.updatedAt ?? ""))) best = i;
  return best?.price?.amount ?? null;
}

/** GET boq line DTO: `unitPrice` (effective), `unitPriceSource`, `lineTotal` (needsInput without override → qty 0). */
export function priceLine(l: BoqLine, libraryPrice: number | null): BoqLine {
  const over = typeof l.priceOverride === "number";
  const unitPrice = over ? l.priceOverride! : libraryPrice;
  const qty = l.needsInput && (l.qtyOverride === null || l.qtyOverride === undefined) ? 0 : (l.qtyOverride ?? l.qty);
  return { ...l, unitPrice, unitPriceSource: over ? "override" : unitPrice === null ? null : "library", lineTotal: contractLineTotal(qty, unitPrice) };
}

/* ---------------- build snapshots (`kamutan.boq-lines/1`) ---------------- */

export function snapshotOf(projectId: string, buildId: string, createdAt: string, lines: readonly BoqLine[], rows: readonly SheetRow[]): BoqLinesSnapshot {
  const sheetVersions: Record<string, string> = {};
  const sheetTitles: Record<string, string> = {};
  for (const r of rows)
    if (r.version?.status === "ready") {
      sheetVersions[r.sheet.id] = r.version.id;
      sheetTitles[r.sheet.id] = sheetName(r).slice(0, 300);
    }
  return {
    schema: BOQ_LINES_SNAPSHOT_SCHEMA,
    projectId,
    buildId,
    createdAt,
    sheetVersions,
    sheetTitles,
    lines: [...lines]
      .sort((a, b) => compareCodes(a.code, b.code))
      .map((l): BoqLinesSnapshotLine => {
        const waiting = Boolean(l.needsInput) && (l.qtyOverride === null || l.qtyOverride === undefined);
        return {
          lineId: l.id,
          chapter: l.chapter,
          code: l.code,
          description: lineDescription(l),
          unit: l.unit,
          qty: waiting ? 0 : (l.qtyOverride ?? l.qty),
          computedQty: l.qty,
          qtyOverride: l.qtyOverride ?? null,
          price: l.unitPrice ?? null,
          priceSource: l.unitPriceSource ?? null,
          priceOverride: l.priceOverride ?? null,
          byFloor: { ...(l.byFloor ?? {}) },
          level: l.level,
          status: l.status,
          ...(waiting ? { needsInput: true } : {}),
          sourceVersions: (l.sourceVersions ?? []).map((s) => ({ sheetId: s.sheetId, versionId: s.versionId })),
        };
      }),
  };
}

/**
 * MOCK-ONLY history: the build "before" the first real one (3 days earlier) — the current lines with deterministic
 * differences: the 2nd and 7th lines are new now, "4.99" was removed, the first source sheet of every 4th sheet-sourced
 * line was at an older version (another quantity), the 4th line had another library price.
 */
export function seedPreviousSnapshot(cur: BoqLinesSnapshot, buildId: string, at: string): BoqLinesSnapshot {
  const sheetVersions = { ...(cur.sheetVersions ?? {}) };
  const lines: BoqLinesSnapshotLine[] = [];
  let sourced = 0;
  cur.lines.forEach((l, i) => {
    if (i === 1 || i === 6) return; // added since
    const copy: BoqLinesSnapshotLine = { ...l, byFloor: { ...(l.byFloor ?? {}) }, sourceVersions: (l.sourceVersions ?? []).map((s) => ({ ...s })) };
    const src = copy.sourceVersions?.[0];
    if (src && !copy.needsInput) {
      sourced++;
      if (sourced % 4 === 1) {
        copy.qty = Math.max(0, copy.qty - (sourced % 8 === 1 ? 2 : -1));
        copy.computedQty = copy.qty;
        copy.byFloor = {};
        sheetVersions[src.sheetId] = "v0";
        copy.sourceVersions = copy.sourceVersions!.map((s, k) => (k === 0 ? { ...s, versionId: "v0" } : s));
      }
    }
    if (i === 3 && copy.price !== null && copy.priceSource === "library") copy.price = Math.round(copy.price * 90) / 100;
    lines.push(copy);
  });
  const first = cur.lines.find((l) => l.chapter === "04" && (l.sourceVersions ?? []).length);
  lines.push({
    lineId: "bl_removed_4_99",
    chapter: "04",
    code: "4.99",
    description: "נקודת חשמל למזגן מיני מרכזי (בוטלה בגרסה החדשה)",
    unit: "נק'",
    qty: 3,
    computedQty: 3,
    price: 210,
    priceSource: "library",
    priceOverride: null,
    byFloor: {},
    sourceVersions: first?.sourceVersions?.slice(0, 1).map((s) => ({ ...s, versionId: "v0" })) ?? [],
  });
  return { ...cur, buildId, createdAt: at, sheetVersions, lines: lines.sort((a, b) => compareCodes(a.code, b.code)) };
}

/* ---------------- comparison (`kamutan.boq-compare/1`, API compare.ts semantics) ---------------- */

/** A snapshot line with qty 0, no sources and not waiting for input is a placeholder (counts as absent). */
const isPlaceholder = (l: BoqLinesSnapshotLine) => l.qty === 0 && !(l.sourceVersions ?? []).length && !l.needsInput;
const totalOf = (l: BoqLinesSnapshotLine | undefined) => (l ? contractLineTotal(l.qty, l.price) : null);

export function compareSnapshots(
  from: BoqLinesSnapshot,
  to: BoqLinesSnapshot,
  base: BoqComparison["base"],
  ref: { fromAt: string | null; toAt: string | null; exportedAt?: string | null },
  now = new Date().toISOString(),
): BoqComparison {
  const fromLines = from.lines.filter((l) => !isPlaceholder(l));
  const toLines = to.lines.filter((l) => !isPlaceholder(l));
  // key: the line id, else (code, unit) — like the API
  const byId = new Map(fromLines.map((l) => [l.lineId, l]));
  const byCodeUnit = new Map(fromLines.map((l) => [`${l.code}\u0000${l.unit}`, l]));
  const matched = new Set<BoqLinesSnapshotLine>();
  const pairs: [BoqLinesSnapshotLine | undefined, BoqLinesSnapshotLine | undefined][] = [];
  for (const t of toLines) {
    const cand = byId.get(t.lineId) ?? byCodeUnit.get(`${t.code}\u0000${t.unit}`);
    const f = cand && !matched.has(cand) ? cand : undefined;
    if (f) matched.add(f);
    pairs.push([f, t]);
  }
  for (const f of fromLines) if (!matched.has(f)) pairs.push([f, undefined]);

  const fromV = from.sheetVersions ?? {};
  const toV = to.sheetVersions ?? {};
  const title = (id: string) => to.sheetTitles?.[id] ?? from.sheetTitles?.[id] ?? null;
  const items: BoqCompareItem[] = [];
  let unchanged = 0;
  for (const [f, t] of pairs) {
    const changes: BoqCompareItem["changes"] = [];
    if (f && t) {
      if (f.qty !== t.qty) changes.push("qty");
      if (f.price !== t.price) changes.push("price");
      if (f.description !== t.description) changes.push("description");
      if (f.unit !== t.unit) changes.push("unit");
      if (!changes.length) {
        unchanged++;
        continue;
      }
    }
    const kind: BoqCompareItem["kind"] = !f ? "added" : !t ? "removed" : "changed";
    const ref2 = (t ?? f)!;
    const causes: BoqCompareCause[] = [];
    const sheets = new Set([...(f?.sourceVersions ?? []), ...(t?.sourceVersions ?? [])].map((s) => s.sheetId));
    for (const sid of sheets) {
      const a = fromV[sid] ?? f?.sourceVersions?.find((s) => s.sheetId === sid)?.versionId ?? null;
      const b = toV[sid] ?? t?.sourceVersions?.find((s) => s.sheetId === sid)?.versionId ?? null;
      if (a !== b) causes.push({ kind: "sheet", sheetId: sid, title: title(sid), fromVersionId: a, toVersionId: b });
    }
    if (f && t) {
      if ((f.qtyOverride ?? null) !== (t.qtyOverride ?? null)) causes.push({ kind: "qty_override" });
      if ((f.priceOverride ?? null) !== (t.priceOverride ?? null)) causes.push({ kind: "price_override" });
      else if (f.price !== t.price) causes.push({ kind: "library_price" });
    }
    if (!causes.length) causes.push({ kind: "other" });
    const ft = totalOf(f);
    const tt = totalOf(t);
    const floors = f?.byFloor && t?.byFloor ? [...new Set([...Object.keys(f.byFloor), ...Object.keys(t.byFloor)])] : [];
    const byFloor = floors
      .map((floor) => ({ floor, fromQty: f!.byFloor![floor] ?? 0, toQty: t!.byFloor![floor] ?? 0, deltaQty: roundMoney((t!.byFloor![floor] ?? 0) - (f!.byFloor![floor] ?? 0)) }))
      .filter((x) => x.deltaQty !== 0);
    items.push({
      kind,
      lineId: ref2.lineId,
      chapter: ref2.chapter,
      code: ref2.code,
      description: ref2.description,
      unit: ref2.unit,
      fromQty: f ? f.qty : null,
      toQty: t ? t.qty : null,
      deltaQty: roundMoney((t?.qty ?? 0) - (f?.qty ?? 0)),
      fromPrice: f ? f.price : null,
      toPrice: t ? t.price : null,
      fromTotal: ft,
      toTotal: tt,
      deltaTotal: ft === null && tt === null ? null : roundMoney((tt ?? 0) - (ft ?? 0)),
      changes,
      ...(byFloor.length ? { byFloor } : {}),
      causes,
    });
  }
  items.sort((a, b) => a.chapter.localeCompare(b.chapter) || compareCodes(a.code, b.code));
  const sum = (ls: BoqLinesSnapshotLine[]) => {
    const priced = ls.filter((l) => l.price !== null);
    return priced.length ? roundMoney(priced.reduce((s, l) => s + (totalOf(l) ?? 0), 0)) : null;
  };
  const fromTotal = sum(fromLines);
  const toTotal = sum(toLines);
  const sheetChanges: BoqComparison["sheetChanges"] = [];
  for (const sid of new Set([...Object.keys(fromV), ...Object.keys(toV)])) {
    const a = fromV[sid] ?? null;
    const b = toV[sid] ?? null;
    if (a !== b) sheetChanges.push({ sheetId: sid, title: title(sid), kind: !a ? "added" : !b ? "removed" : "revised", fromVersionId: a, toVersionId: b });
  }
  const count = (k: BoqCompareItem["kind"]) => items.filter((x) => x.kind === k).length;
  return {
    schema: BOQ_COMPARE_SCHEMA,
    projectId: to.projectId,
    base,
    from: { buildId: from.buildId, at: ref.fromAt, ...(base === "export" ? { exportId: `x_${from.buildId}`, exportedAt: ref.exportedAt ?? null } : {}) },
    to: { buildId: to.buildId, at: ref.toAt },
    summary: {
      added: count("added"),
      removed: count("removed"),
      changed: count("changed"),
      unchanged,
      fromTotal,
      toTotal,
      deltaTotal: fromTotal === null && toTotal === null ? null : roundMoney((toTotal ?? 0) - (fromTotal ?? 0)),
    },
    sheetChanges,
    items,
    generatedAt: now,
  };
}

/* ---------------- price import (Worker-BOQ, `mode: 'prices'`) ---------------- */

/** The rows of the demo "priced past BOQ": most library codes (every 5th 8% dearer), 2 codes the library lacks. */
export function demoPriceFile(items: readonly LibraryItem[]): PriceImportRow[] {
  const rows = items
    .filter((i) => i.active)
    .slice(0, 40)
    .map((i, k): PriceImportRow => {
      const seed = seedPriceFor(i.code, i.unit) ?? 150;
      return { row: k + 3, code: i.code, description: i.description, amount: Math.round((k % 5 === 0 ? seed * 1.08 : seed) * 100) / 100 };
    });
  return [
    ...rows,
    { row: rows.length + 3, code: "4.40", description: "הזנה לעמדת טעינה לרכב חשמלי", amount: 2850 },
    { row: rows.length + 4, code: "11.02", description: "שילוט חירום פולט אור", amount: 145.5 },
  ];
}

/** The worker's run: `planPriceImport` over the ACTIVE library (the mock's ids are not `itemIdFor` ids). */
export function runPriceImport(items: readonly LibraryItem[], rows: readonly PriceImportRow[], overwriteManual: boolean): { writes: { itemId: string; amount: number }[]; report: PriceImportReport } {
  return planPriceImport(
    items.map((i) => ({ id: i.id, code: i.code, description: i.description, active: i.active, price: i.price ?? null })),
    rows,
    { overwriteManual, idFor: () => "", normalize: (s) => s.replace(/\s+/g, " ").trim() },
  );
}

/* ---------------- "תוספות ושינויים" spreadsheet ---------------- */

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const KIND_HE = { added: "נוסף", removed: "הוסר", changed: "שונה" } as const;

/** SpreadsheetML 2003 (RTL sheet, number cells, Δ₪ as a formula) — Excel opens it as a workbook. */
export function comparisonSpreadsheet(c: BoqComparison, title: string): string {
  const cell = (v: string | number | null) =>
    v === null || v === "" ? "<Cell/>" : typeof v === "number" ? `<Cell><Data ss:Type="Number">${v}</Data></Cell>` : `<Cell><Data ss:Type="String">${xml(v)}</Data></Cell>`;
  const head = ["סעיף", "תאור העבודה", "יחידה", "שינוי", "כמות לפני", "כמות אחרי", "Δ כמות", "מחיר לפני", "מחיר אחרי", 'סה"כ לפני', 'סה"כ אחרי', "Δ ₪", "סיבה"];
  const cause = (x: BoqCompareCause) => (x.kind === "sheet" ? (x.title ?? x.sheetId) : { qty_override: "כמות ידנית", price_override: "מחיר ידני", library_price: "מחיר בספרייה", other: "אחר" }[x.kind]);
  const rows = c.items.map(
    (l) =>
      `<Row>${[
        cell(l.code),
        cell(l.description),
        cell(l.unit),
        cell(KIND_HE[l.kind]),
        cell(l.fromQty),
        cell(l.toQty),
        cell(l.deltaQty),
        cell(l.fromPrice),
        cell(l.toPrice),
        cell(l.fromTotal),
        cell(l.toTotal),
        `<Cell ss:Formula="=N(RC[-1])-N(RC[-2])"><Data ss:Type="Number">${l.deltaTotal ?? 0}</Data></Cell>`,
        cell(l.causes.map(cause).join(", ")),
      ].join("")}</Row>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="תוספות ושינויים" ss:RightToLeft="1"><Table>
<Row>${cell(title)}</Row>
<Row>${head.map((h) => cell(h)).join("")}</Row>
${rows.join("\n")}
<Row>${cell('סה"כ שינוי')}${"<Cell/>".repeat(10)}${cell(c.summary.deltaTotal)}</Row>
</Table></Worksheet></Workbook>`;
}
