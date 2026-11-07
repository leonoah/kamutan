import {
  BOQ_COMPARE_KIND_HE,
  BOQ_COMPARE_SCHEMA,
  chapterKey,
  compareItemCodes,
  COMPARE_SHEET_NAME,
  lineTotal,
  roundMoney,
  type BoqCompareCause,
  type BoqCompareItem,
  type BoqComparison,
  type BoqLinesSnapshot,
  type BoqLinesSnapshotLine,
} from '@kamutan/contracts';
import ExcelJS from 'exceljs';
import { colLetter, CURRENCY_FMT, sanitizeCell } from './excel';

/**
 * Sprint 8 "מה השתנה": pure comparison of two build snapshots (`kamutan.boq-lines/1`, written by Worker-BOQ) and the
 * Excel "תוספות ושינויים". Lines are matched by lineId (stable across rebuilds), then — for leftovers — by (code, unit).
 */

const EPS = 1e-9;
const differs = (a: number | null | undefined, b: number | null | undefined): boolean => {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) !== (b ?? null);
  return Math.abs(a - b) > EPS;
};
const r6 = roundMoney;

export interface CompareInput {
  projectId: string;
  base: BoqComparison['base'];
  from: BoqLinesSnapshot;
  to: BoqLinesSnapshot;
  fromAt: string | null;
  toAt: string | null;
  fromExport?: { exportId: string; exportedAt: string } | null;
  /** sheetId → display title (snapshot titles win). */
  titles?: ReadonlyMap<string, string>;
  now?: Date;
}

const versionsOf = (l: BoqLinesSnapshotLine | undefined): Map<string, string> => new Map((l?.sourceVersions ?? []).map((s) => [s.sheetId, s.versionId]));
const totalOf = (l: BoqLinesSnapshotLine | undefined): number | null => (l ? lineTotal(l.qty, l.price) : null);

/**
 * A line the build keeps only as a placeholder (Worker-BOQ keeps an obsolete line that carries human marks at qty 0,
 * without sources) is ABSENT for the comparison — same rule as the worker's reference `snapshot.compare`.
 */
export const isPlaceholder = (l: BoqLinesSnapshotLine): boolean => l.qty === 0 && (l.sourceVersions ?? []).length === 0 && l.needsInput !== true;

export function compareSnapshots(input: CompareInput): BoqComparison {
  const from = { ...input.from, lines: input.from.lines.filter((l) => !isPlaceholder(l)) };
  const to = { ...input.to, lines: input.to.lines.filter((l) => !isPlaceholder(l)) };
  const title = (sheetId: string): string | null => to.sheetTitles?.[sheetId] ?? from.sheetTitles?.[sheetId] ?? input.titles?.get(sheetId) ?? null;
  const fromSheets = new Map(Object.entries(from.sheetVersions ?? {}));
  const toSheets = new Map(Object.entries(to.sheetVersions ?? {}));

  // --- line matching: id, then (code, unit) among the leftovers
  const fromById = new Map(from.lines.map((l) => [l.lineId, l]));
  const pairs: Array<[BoqLinesSnapshotLine | undefined, BoqLinesSnapshotLine | undefined]> = [];
  const unmatchedTo: BoqLinesSnapshotLine[] = [];
  for (const l of to.lines) {
    const f = fromById.get(l.lineId);
    if (f) {
      pairs.push([f, l]);
      fromById.delete(l.lineId);
    } else unmatchedTo.push(l);
  }
  const leftovers = new Map<string, BoqLinesSnapshotLine[]>();
  for (const f of fromById.values()) {
    const k = `${f.code}\u0000${f.unit}`;
    leftovers.set(k, [...(leftovers.get(k) ?? []), f]);
  }
  for (const l of unmatchedTo) {
    const cands = leftovers.get(`${l.code}\u0000${l.unit}`);
    const f = cands?.shift();
    pairs.push([f, l]);
  }
  for (const rest of leftovers.values()) for (const f of rest) pairs.push([f, undefined]);

  // --- per line
  const items: BoqCompareItem[] = [];
  let unchanged = 0;
  for (const [f, t] of pairs) {
    const changes: BoqCompareItem['changes'] = [];
    if (f && t) {
      if (differs(f.qty, t.qty)) changes.push('qty');
      if (differs(f.price, t.price)) changes.push('price');
      if (f.description !== t.description) changes.push('description');
      if (f.unit !== t.unit) changes.push('unit');
      if (changes.length === 0) {
        unchanged++;
        continue;
      }
    }
    const kind: BoqCompareItem['kind'] = f && t ? 'changed' : t ? 'added' : 'removed';
    const ref = (t ?? f) as BoqLinesSnapshotLine;
    const fromTotal = totalOf(f);
    const toTotal = totalOf(t);
    const item: BoqCompareItem = {
      kind,
      lineId: ref.lineId,
      chapter: ref.chapter,
      code: ref.code,
      description: ref.description,
      unit: ref.unit,
      fromQty: f ? f.qty : null,
      toQty: t ? t.qty : null,
      deltaQty: r6((t?.qty ?? 0) - (f?.qty ?? 0)),
      fromPrice: f ? f.price : null,
      toPrice: t ? t.price : null,
      fromTotal,
      toTotal,
      deltaTotal: fromTotal === null && toTotal === null ? null : r6((toTotal ?? 0) - (fromTotal ?? 0)),
      changes,
      causes: causesOf(f, t, fromSheets, toSheets, title),
    };
    const bf = floorDelta(f, t);
    if (bf) item.byFloor = bf;
    items.push(item);
  }
  items.sort((a, b) => compareItemCodes(chapterKey(a.chapter), chapterKey(b.chapter)) || compareItemCodes(a.code, b.code) || a.lineId.localeCompare(b.lineId));

  const sum = (s: BoqLinesSnapshot): number | null => {
    const priced = s.lines.filter((l) => typeof l.price === 'number');
    return priced.length ? r6(priced.reduce((a, l) => a + (lineTotal(l.qty, l.price) ?? 0), 0)) : null;
  };
  const fromTotal = sum(from);
  const toTotal = sum(to);
  const sheetIds = [...new Set([...fromSheets.keys(), ...toSheets.keys()])].sort();
  const sheetChanges: BoqComparison['sheetChanges'] = [];
  for (const sid of sheetIds) {
    const a = fromSheets.get(sid) ?? null;
    const b = toSheets.get(sid) ?? null;
    if (a === b) continue;
    sheetChanges.push({ sheetId: sid, title: title(sid), kind: a === null ? 'added' : b === null ? 'removed' : 'revised', fromVersionId: a, toVersionId: b });
  }
  return {
    schema: BOQ_COMPARE_SCHEMA,
    projectId: input.projectId,
    base: input.base,
    from: { buildId: from.buildId, at: input.fromAt, ...(input.fromExport ? { exportId: input.fromExport.exportId, exportedAt: input.fromExport.exportedAt } : {}) },
    to: { buildId: to.buildId, at: input.toAt },
    summary: {
      added: items.filter((i) => i.kind === 'added').length,
      removed: items.filter((i) => i.kind === 'removed').length,
      changed: items.filter((i) => i.kind === 'changed').length,
      unchanged,
      fromTotal,
      toTotal,
      deltaTotal: fromTotal === null && toTotal === null ? null : r6((toTotal ?? 0) - (fromTotal ?? 0)),
    },
    sheetChanges,
    items,
    generatedAt: (input.now ?? new Date()).toISOString(),
  };
}

/**
 * Causes: every sheet of the line's evidence (either side) whose version differs between the builds (the build-level
 * `sheetVersions`, else the line's own source versions); then the project's manual values; `other` when nothing explains it.
 */
function causesOf(
  f: BoqLinesSnapshotLine | undefined,
  t: BoqLinesSnapshotLine | undefined,
  fromSheets: ReadonlyMap<string, string>,
  toSheets: ReadonlyMap<string, string>,
  title: (sheetId: string) => string | null,
): BoqCompareCause[] {
  const out: BoqCompareCause[] = [];
  const fv = versionsOf(f);
  const tv = versionsOf(t);
  const hasBuildMaps = fromSheets.size > 0 || toSheets.size > 0;
  for (const sid of [...new Set([...fv.keys(), ...tv.keys()])].sort()) {
    const a = hasBuildMaps ? (fromSheets.get(sid) ?? null) : (fv.get(sid) ?? null);
    const b = hasBuildMaps ? (toSheets.get(sid) ?? null) : (tv.get(sid) ?? null);
    if (a !== b) out.push({ kind: 'sheet', sheetId: sid, title: title(sid), fromVersionId: a, toVersionId: b });
  }
  if (f && t) {
    if (differs(f.qtyOverride, t.qtyOverride)) out.push({ kind: 'qty_override' });
    if (differs(f.price, t.price)) out.push(differs(f.priceOverride, t.priceOverride) || f.priceSource !== t.priceSource ? { kind: 'price_override' } : { kind: 'library_price' });
  }
  if (out.length === 0) out.push({ kind: 'other' });
  return out;
}

function floorDelta(f: BoqLinesSnapshotLine | undefined, t: BoqLinesSnapshotLine | undefined): BoqCompareItem['byFloor'] | undefined {
  if (!f?.byFloor && !t?.byFloor) return undefined;
  const a = f?.byFloor ?? {};
  const b = t?.byFloor ?? {};
  const out = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .map((floor) => ({ floor, fromQty: a[floor] ?? 0, toQty: b[floor] ?? 0, deltaQty: r6((b[floor] ?? 0) - (a[floor] ?? 0)) }))
    .filter((x) => Math.abs(x.deltaQty) > EPS);
  return out.length ? out : undefined;
}

// ---------------------------------------------------------------------------
// Excel "תוספות ושינויים"
// ---------------------------------------------------------------------------

export const COMPARE_COLUMNS = ['סעיף', 'תאור העבודה', 'יחידה', 'סוג שינוי', 'כמות קודמת', 'כמות חדשה', 'הפרש כמות', "מחיר יח' קודם", "מחיר יח' חדש", 'סה"כ קודם', 'סה"כ חדש', 'הפרש ₪', 'סיבה'] as const;
export const COMPARE_TOTAL = 'סה"כ';

const CAUSE_HE = (c: BoqCompareCause): string => {
  switch (c.kind) {
    case 'sheet':
      return `${c.toVersionId === null ? 'גיליון הוסר' : c.fromVersionId === null ? 'גיליון נוסף' : 'גרסת גיליון חדשה'}: ${c.title ?? c.sheetId}`;
    case 'qty_override':
      return 'כמות ידנית';
    case 'price_override':
      return 'מחיר ידני';
    case 'library_price':
      return 'מחיר בספרייה';
    default:
      return 'שינוי בחישוב';
  }
};

/** One row per added / removed / changed line; Δ columns are formulas; a SUM row closes the money columns. */
export async function buildCompareWorkbook(cmp: BoqComparison, projectName: string, date: Date): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Kamutan';
  wb.created = date;
  wb.modified = date;
  const ws = wb.addWorksheet(COMPARE_SHEET_NAME, { views: [{ rightToLeft: true }] });
  ws.columns = COMPARE_COLUMNS.map((_, i) => ({ width: i === 1 ? 50 : i === 12 ? 40 : 12 }));
  const n = COMPARE_COLUMNS.length;
  const full = (r: number, text: string, bold = true) => {
    ws.mergeCells(r, 1, r, n);
    const c = ws.getCell(r, 1);
    c.value = sanitizeCell(text);
    c.style = { font: { bold, size: bold ? 13 : 11 }, alignment: { horizontal: 'center', readingOrder: 'rtl' } };
  };
  const d = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('he-IL') : '—');
  full(1, `${COMPARE_SHEET_NAME} — ${projectName}`);
  full(2, `השוואה בין החישוב מ-${d(cmp.from.at)} לחישוב מ-${d(cmp.to.at)}: ${cmp.summary.added} נוספו, ${cmp.summary.removed} הוסרו, ${cmp.summary.changed} שונו`, false);
  const head = 4;
  COMPARE_COLUMNS.forEach((t, i) => {
    const c = ws.getCell(head, i + 1);
    c.value = t;
    c.style = { font: { bold: true }, alignment: { horizontal: 'center', wrapText: true }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } } };
  });
  ws.views = [{ rightToLeft: true, state: 'frozen', ySplit: head }];
  let r = head + 1;
  const first = r;
  const L = (c: number) => colLetter(c);
  for (const it of cmp.items) {
    ws.getCell(r, 1).value = sanitizeCell(it.code);
    ws.getCell(r, 1).numFmt = '@';
    ws.getCell(r, 2).value = sanitizeCell(it.description);
    ws.getCell(r, 3).value = sanitizeCell(it.unit);
    ws.getCell(r, 4).value = BOQ_COMPARE_KIND_HE[it.kind];
    if (it.fromQty !== null) ws.getCell(r, 5).value = it.fromQty;
    if (it.toQty !== null) ws.getCell(r, 6).value = it.toQty;
    ws.getCell(r, 7).value = { formula: `N(${L(6)}${r})-N(${L(5)}${r})`, result: it.deltaQty };
    if (it.fromPrice !== null) ws.getCell(r, 8).value = it.fromPrice;
    if (it.toPrice !== null) ws.getCell(r, 9).value = it.toPrice;
    ws.getCell(r, 10).value = { formula: `N(${L(5)}${r})*N(${L(8)}${r})`, result: it.fromTotal ?? 0 };
    ws.getCell(r, 11).value = { formula: `N(${L(6)}${r})*N(${L(9)}${r})`, result: it.toTotal ?? 0 };
    ws.getCell(r, 12).value = { formula: `${L(11)}${r}-${L(10)}${r}`, result: it.deltaTotal ?? 0 };
    ws.getCell(r, 13).value = sanitizeCell(it.causes.map(CAUSE_HE).join('; '));
    for (const c of [8, 9, 10, 11, 12]) ws.getCell(r, c).numFmt = CURRENCY_FMT;
    r++;
  }
  const last = r - 1;
  ws.getCell(r, 2).value = COMPARE_TOTAL;
  ws.getCell(r, 2).font = { bold: true };
  for (const [c, v] of [
    [10, cmp.items.reduce((a, i) => a + (i.fromTotal ?? 0), 0)],
    [11, cmp.items.reduce((a, i) => a + (i.toTotal ?? 0), 0)],
    [12, cmp.items.reduce((a, i) => a + (i.deltaTotal ?? 0), 0)],
  ] as const) {
    ws.getCell(r, c).value = { formula: last >= first ? `SUM(${L(c)}${first}:${L(c)}${last})` : '0', result: r6(v) };
    ws.getCell(r, c).numFmt = CURRENCY_FMT;
    ws.getCell(r, c).font = { bold: true };
  }
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}
