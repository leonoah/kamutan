import {
  BOQ_STATUS_HE,
  chapterKey,
  compareItemCodes,
  CONFIDENCE_HE,
  effectiveQty,
  type BoqLine,
  type BoqTemplate,
  type BoqTemplateColumnKey,
  type ConfidenceLevel,
} from '@kamutan/contracts';
import ExcelJS from 'exceljs';

/**
 * Excel export of a project BOQ in the client's format (Sprint 3 brief "Excel export"; UX §export; SEC-39).
 *  - Sheet "כמויות": RTL, optional warning row, template title rows, header (template columns + "רמת ביטחון" +
 *    "סטטוס" at the end = far left in RTL), per chapter: header row, "הערות:" + numbered notes, line rows (code as
 *    TEXT, empty unit price, total = qty × price formula), "סה"כ" row (SUM formula); grand totals before/after VAT.
 *  - Sheet "פירוט לפי קומה": quantity per floor (+ SUM formula) and the final (override-aware) quantity.
 *  - Sheet "ראיות": line → sheet / floor / number of items on the drawing.
 * Every text cell coming from users / OCR / templates is passed through `sanitizeCell` (formula injection).
 */

export const MAIN_SHEET = 'כמויות';
export const FLOOR_SHEET = 'פירוט לפי קומה';
export const EVIDENCE_SHEET = 'ראיות';
export const CONFIDENCE_TITLE = 'רמת ביטחון';
export const STATUS_TITLE = 'סטטוס';
export const NOTES_TITLE = 'הערות:';
export const CHAPTER_TOTAL = 'סה"כ';
export const GRAND_TOTAL = 'סה"כ כללי לא כולל מע"מ';
export const GRAND_TOTAL_VAT = 'סה"כ כללי כולל מע"מ';
export const DRAFT_NOTE = 'טיוטה – כולל פריטים שלא אומתו';
export const NO_FLOOR = 'ללא קומה';
/** Currency format of the client's sample (price / total columns). */
export const CURRENCY_FMT = '"₪"\\ #,##0';

/** Hebrew display names of the worker's floor codes; project FloorMeta names win (`ExcelInput.floorNames`). */
export const DEFAULT_FLOOR_NAMES: Readonly<Record<string, string>> = Object.freeze({
  basement: 'מרתף',
  '-1': 'מרתף',
  ground: 'קומת קרקע',
  '0': 'קומת קרקע',
  first: "קומה א'",
  '1': "קומה א'",
  second: "קומה ב'",
  '2': "קומה ב'",
  third: "קומה ג'",
  '3': "קומה ג'",
  roof: 'גג',
  gallery: 'גלריה',
});

/** SEC-39: a cell starting with = + - @ TAB CR gets a leading apostrophe; control chars (except \n) are dropped. */
export function sanitizeCell(v: string): string {
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export const warningText = (red: number, yellow: number): string =>
  `יש פריטים שלא נבדקו: בכתב הכמויות יש ${red} שורות "לבדיקה" ו-${yellow} שורות "סביר". הכמויות בהן עלולות להיות שגויות.`;

export interface EvidenceGroup {
  /** Sheet title (or id) for display. */
  sheet: string;
  floor: string | null;
  count: number;
  /** Detection ids of this group (shown truncated in "ראיות"). */
  detectionIds?: readonly string[];
  /** Switch groups (composite lighting lines): one unit each; ids from links.json.gz. */
  linkGroups?: ReadonlyArray<{ id: string; switchIds: readonly string[]; pointIds: readonly string[] }>;
}

/** "lk_2: מפסקים d_1, d_2 → נקודות pt_1" */
export const linkGroupText = (g: { id: string; switchIds: readonly string[]; pointIds: readonly string[] }): string =>
  `${g.id}: מפסקים ${g.switchIds.length ? g.switchIds.join(', ') : '—'} → נקודות ${g.pointIds.length ? g.pointIds.join(', ') : '—'}`;

export interface ExcelInput {
  projectName: string;
  orgName?: string;
  date: Date;
  template: BoqTemplate;
  lines: readonly BoqLine[];
  split: 'summed' | 'byFloor';
  markDraft: boolean;
  /** lineId → evidence grouped by (sheet, floor). Missing = no evidence file. */
  evidence: ReadonlyMap<string, readonly EvidenceGroup[]>;
  /** VAT of the grand total (org setting `vatRate`, else the template's, default 0.18). */
  vatRate?: number;
  /** floor code → display name (merged over DEFAULT_FLOOR_NAMES). */
  floorNames?: Readonly<Record<string, string>>;
}

const floorName = (input: ExcelInput, f: string) => input.floorNames?.[f] ?? DEFAULT_FLOOR_NAMES[f] ?? f;

type ColKey = BoqTemplateColumnKey | 'confidence' | 'status';

const LEVEL_COLOR: Record<ConfidenceLevel, string> = { green: 'FF1B7F5A', yellow: 'FFB26B00', red: 'FFC2410C' };
const thin = { style: 'thin' as const, color: { argb: 'FF9CA3AF' } };
const BORDER = { top: thin, bottom: thin, left: thin, right: thin };

const dateHe = (d: Date) => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;

/** Lines sorted by natural code order, then id. */
const byCode = (a: BoqLine, b: BoqLine) => compareItemCodes(a.code, b.code) || a.id.localeCompare(b.id);

interface ChapterGroup {
  title: string;
  notes: readonly string[];
  lines: BoqLine[];
}

/** Template chapter order; lines matched by chapter code, then by code major (`codePrefixes`); leftovers appended. */
export function groupByChapter(template: BoqTemplate, lines: readonly BoqLine[]): ChapterGroup[] {
  const groups: ChapterGroup[] = template.chapters.map((c) => ({ title: c.title, notes: c.notes, lines: [] }));
  const byKey = new Map(template.chapters.map((c, i) => [chapterKey(c.code), i]));
  const byPrefix = new Map<string, number>();
  template.chapters.forEach((c, i) => c.codePrefixes?.forEach((p) => byPrefix.has(p) || byPrefix.set(p, i)));
  const extra = new Map<string, ChapterGroup>();
  for (const l of lines) {
    const major = l.code.split(/[.\-/]/)[0] ?? '';
    const idx = byKey.get(chapterKey(l.chapter)) ?? byPrefix.get(major) ?? byPrefix.get(major.replace(/^0+(?=\d)/, ''));
    if (idx !== undefined) {
      (groups[idx] as ChapterGroup).lines.push(l);
    } else {
      const k = chapterKey(l.chapter) || major;
      if (!extra.has(k)) extra.set(k, { title: `פרק ${l.chapter || major}`, notes: [], lines: [] });
      (extra.get(k) as ChapterGroup).lines.push(l);
    }
  }
  return [...groups, ...[...extra.values()]].filter((g) => g.lines.length > 0).map((g) => ({ ...g, lines: g.lines.sort(byCode) }));
}

/** Floors in first-seen order over the sorted lines. */
export function floorsOf(lines: readonly BoqLine[]): string[] {
  const seen: string[] = [];
  for (const l of [...lines].sort(byCode)) {
    const fl = Object.keys(l.byFloor ?? {});
    if (fl.length === 0 && l.floor) fl.push(l.floor);
    for (const f of fl) if (!seen.includes(f)) seen.push(f);
  }
  return seen;
}

function colLetter(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

export async function buildBoqWorkbook(input: ExcelInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Kamutan';
  wb.created = input.date;
  wb.modified = input.date;

  const counts = { red: 0, yellow: 0 };
  for (const l of input.lines) if (l.level !== 'green') counts[l.level]++;

  buildMainSheet(wb, input, counts);
  buildFloorSheet(wb, input);
  buildEvidenceSheet(wb, input);

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

function buildMainSheet(wb: ExcelJS.Workbook, input: ExcelInput, counts: { red: number; yellow: number }): void {
  const ws = wb.addWorksheet(MAIN_SHEET, { views: [{ rightToLeft: true }], properties: { defaultRowHeight: 18 } });
  const cols: Array<{ key: ColKey; title: string; width: number }> = [
    ...input.template.columns.map((c) => ({ key: c.key as ColKey, title: c.title, width: c.width ?? defaultWidth(c.key) })),
    { key: 'confidence', title: CONFIDENCE_TITLE, width: 12 },
    { key: 'status', title: STATUS_TITLE, width: 10 },
  ];
  const col = new Map<ColKey, number>(cols.map((c, i) => [c.key, i + 1]));
  ws.columns = cols.map((c) => ({ width: c.width }));
  const lastCol = cols.length;
  const textCol = col.get('description') ?? col.get('code') ?? 1;
  const qtyCol = col.get('qty') as number;
  const priceCol = col.get('unitPrice');
  const totalCol = col.get('total');

  let r = 1;
  const fullRow = (text: string, style: Partial<ExcelJS.Style>, height?: number) => {
    ws.mergeCells(r, 1, r, lastCol);
    const cell = ws.getCell(r, 1);
    cell.value = sanitizeCell(text);
    cell.style = { alignment: { horizontal: 'center', vertical: 'middle', wrapText: true, readingOrder: 'rtl' }, ...style };
    if (height) ws.getRow(r).height = height;
    r++;
  };

  if (counts.red + counts.yellow > 0) {
    fullRow(warningText(counts.red, counts.yellow), {
      font: { bold: true, color: { argb: 'FFC2410C' } },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEDD5' } },
    }, 32);
  }
  const vars: Record<string, string> = { projectName: input.projectName, date: dateHe(input.date), orgName: input.orgName ?? '' };
  input.template.titleRows.forEach((t, i) => {
    fullRow(t.replace(/\{(projectName|date|orgName)\}/g, (_, k: string) => vars[k] ?? ''), { font: { bold: true, size: i === 0 ? 14 : 12 } });
  });
  if (input.markDraft) fullRow(DRAFT_NOTE, { font: { bold: true, color: { argb: 'FFC2410C' } } });

  // Header
  const headerRow = r;
  cols.forEach((c, i) => {
    const cell = ws.getCell(r, i + 1);
    cell.value = sanitizeCell(c.title);
    cell.style = { font: { bold: true }, alignment: { horizontal: 'center', vertical: 'middle', wrapText: true }, border: BORDER, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } } };
  });
  r++;
  ws.views = [{ rightToLeft: true, state: 'frozen', ySplit: headerRow, xSplit: 0 }];

  const chapterTotals: string[] = [];
  for (const ch of groupByChapter(input.template, input.lines)) {
    // chapter header
    const h = ws.getCell(r, textCol);
    h.value = sanitizeCell(ch.title);
    h.style = { font: { bold: true, underline: true, size: 12 } };
    r++;
    if (ch.notes.length) {
      ws.getCell(r, textCol).value = NOTES_TITLE;
      ws.getCell(r, textCol).style = { font: { bold: true } };
      r++;
      for (const n of ch.notes) {
        const c = ws.getCell(r, textCol);
        c.value = sanitizeCell(n);
        c.style = { alignment: { wrapText: true, vertical: 'top' } };
        r++;
      }
    }
    const first = r;
    for (const l of ch.lines) {
      const rows = input.split === 'byFloor' ? floorRows(l).map((x) => ({ ...x, suffix: x.suffix === null ? null : floorName(input, x.suffix) })) : [{ suffix: null as string | null, qty: effectiveQty(l) }];
      for (const row of rows) {
        writeLineRow(ws, r, l, row, col, qtyCol, priceCol, totalCol);
        r++;
      }
    }
    const last = r - 1;
    const label = ws.getCell(r, textCol);
    label.value = CHAPTER_TOTAL;
    label.style = { font: { bold: true } };
    if (totalCol) {
      const L = colLetter(totalCol);
      const t = ws.getCell(r, totalCol);
      t.value = { formula: `SUM(${L}${first}:${L}${last})`, result: 0 };
      t.style = { font: { bold: true }, numFmt: CURRENCY_FMT, border: { top: thin } };
      chapterTotals.push(`${L}${r}`);
    }
    r += 2; // blank row between chapters
  }

  if (totalCol) {
    const L = colLetter(totalCol);
    ws.getCell(r, textCol).value = GRAND_TOTAL;
    ws.getCell(r, textCol).style = { font: { bold: true } };
    ws.getCell(r, totalCol).value = { formula: chapterTotals.length ? `SUM(${chapterTotals.join(',')})` : '0', result: 0 };
    ws.getCell(r, totalCol).style = { font: { bold: true }, numFmt: CURRENCY_FMT };
    const before = `${L}${r}`;
    r++;
    ws.getCell(r, textCol).value = GRAND_TOTAL_VAT;
    ws.getCell(r, textCol).style = { font: { bold: true } };
    ws.getCell(r, totalCol).value = { formula: `${before}*(1+${input.vatRate ?? input.template.vatRate})`, result: 0 };
    ws.getCell(r, totalCol).style = { font: { bold: true }, numFmt: CURRENCY_FMT };
  }
}

function defaultWidth(k: BoqTemplateColumnKey): number {
  return k === 'description' ? 60 : k === 'code' ? 8 : 12;
}

/** byFloor split rows; an overridden line stays one row (the override is not distributed over floors). */
function floorRows(l: BoqLine): Array<{ suffix: string | null; qty: number }> {
  const entries = Object.entries(l.byFloor ?? {}).filter(([, q]) => q !== 0);
  if (l.qtyOverride !== null && l.qtyOverride !== undefined) return [{ suffix: null, qty: l.qtyOverride }];
  if (entries.length <= 1) return [{ suffix: entries[0]?.[0] ?? l.floor ?? null, qty: l.qty }];
  return entries.map(([f, q]) => ({ suffix: f, qty: q }));
}

function writeLineRow(
  ws: ExcelJS.Worksheet,
  r: number,
  l: BoqLine,
  row: { suffix: string | null; qty: number },
  col: Map<ColKey, number>,
  qtyCol: number,
  priceCol: number | undefined,
  totalCol: number | undefined,
): void {
  const set = (k: ColKey, v: ExcelJS.CellValue, style: Partial<ExcelJS.Style> = {}) => {
    const c = col.get(k);
    if (!c) return;
    const cell = ws.getCell(r, c);
    cell.value = v;
    cell.style = { border: BORDER, alignment: { vertical: 'top', wrapText: true }, ...style };
  };
  // TEXT code: string value + "@" format, so "4.10" never becomes 4.1 (decision #9).
  set('code', sanitizeCell(l.code), { numFmt: '@', alignment: { horizontal: 'center', vertical: 'top' } });
  set('description', sanitizeCell(row.suffix ? `${l.description} – ${row.suffix}` : l.description));
  set('unit', sanitizeCell(l.unit), { alignment: { horizontal: 'center', vertical: 'top' } });
  set('qty', row.qty, { numFmt: 'General', alignment: { horizontal: 'center', vertical: 'top' } });
  if (l.qtyOverride !== null && l.qtyOverride !== undefined) {
    const c = ws.getCell(r, qtyCol);
    c.note = sanitizeCell(`כמות שונתה ידנית (מחושב: ${l.qty})${l.qtyOverrideReason ? `: ${l.qtyOverrideReason}` : ''}`);
  }
  set('unitPrice', null, { numFmt: CURRENCY_FMT });
  if (totalCol) {
    const Q = colLetter(qtyCol);
    const formula = priceCol ? `${Q}${r}*${colLetter(priceCol)}${r}` : '0';
    set('total', { formula, result: 0 }, { numFmt: CURRENCY_FMT });
  }
  set('confidence', CONFIDENCE_HE[l.level], { font: { bold: true, color: { argb: LEVEL_COLOR[l.level] } }, alignment: { horizontal: 'center', vertical: 'top' } });
  set('status', BOQ_STATUS_HE[l.status], { alignment: { horizontal: 'center', vertical: 'top' } });
}

function buildFloorSheet(wb: ExcelJS.Workbook, input: ExcelInput): void {
  const ws = wb.addWorksheet(FLOOR_SHEET, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  const lines = [...input.lines].sort(byCode);
  const floors = floorsOf(lines);
  const needsNoFloor = lines.some((l) => Object.keys(l.byFloor ?? {}).length === 0 && !l.floor);
  const floorCols = needsNoFloor ? [...floors, NO_FLOOR] : floors;
  const head = ['סעיף', 'תאור העבודה', 'יחידה', ...floorCols.map((f) => (f === NO_FLOOR ? f : floorName(input, f))), 'סה"כ לפי קומות', 'כמות סופית', CONFIDENCE_TITLE];
  ws.columns = head.map((_, i) => ({ width: i === 1 ? 50 : 12 }));
  head.forEach((t, i) => {
    const c = ws.getCell(1, i + 1);
    c.value = sanitizeCell(t);
    c.style = { font: { bold: true }, border: BORDER, alignment: { horizontal: 'center', wrapText: true }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } } };
  });
  const firstFloor = 4;
  const sumCol = firstFloor + floorCols.length;
  lines.forEach((l, i) => {
    const r = i + 2;
    ws.getCell(r, 1).value = sanitizeCell(l.code);
    ws.getCell(r, 1).numFmt = '@';
    ws.getCell(r, 2).value = sanitizeCell(l.description);
    ws.getCell(r, 3).value = sanitizeCell(l.unit);
    const per: Record<string, number> = { ...(l.byFloor ?? {}) };
    if (Object.keys(per).length === 0) per[l.floor ?? NO_FLOOR] = l.qty;
    floorCols.forEach((f, j) => {
      if (per[f] !== undefined) ws.getCell(r, firstFloor + j).value = per[f] as number;
    });
    ws.getCell(r, sumCol).value = floorCols.length
      ? { formula: `SUM(${colLetter(firstFloor)}${r}:${colLetter(sumCol - 1)}${r})`, result: Object.values(per).reduce((a, b) => a + b, 0) }
      : 0;
    ws.getCell(r, sumCol + 1).value = effectiveQty(l);
    ws.getCell(r, sumCol + 2).value = CONFIDENCE_HE[l.level];
    ws.getCell(r, sumCol + 2).font = { color: { argb: LEVEL_COLOR[l.level] }, bold: true };
  });
}

function buildEvidenceSheet(wb: ExcelJS.Workbook, input: ExcelInput): void {
  const ws = wb.addWorksheet(EVIDENCE_SHEET, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  const head = ['סעיף', 'תאור העבודה', 'גיליון', 'קומה', 'כמות בשרטוט', 'סיבות', 'מזהי פריטים', 'קבוצות מפסק↔גוף תאורה'];
  ws.columns = [{ width: 8 }, { width: 45 }, { width: 30 }, { width: 14 }, { width: 12 }, { width: 50 }, { width: 40 }, { width: 60 }];
  head.forEach((t, i) => {
    const c = ws.getCell(1, i + 1);
    c.value = t;
    c.style = { font: { bold: true }, border: BORDER, alignment: { horizontal: 'center', wrapText: true }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } } };
  });
  let r = 2;
  for (const l of [...input.lines].sort(byCode)) {
    const groups = input.evidence.get(l.id) ?? [];
    const rows = groups.length ? groups : [{ sheet: '—', floor: l.floor ?? null, count: l.evidenceCount ?? 0 }];
    rows.forEach((g, i) => {
      ws.getCell(r, 1).value = sanitizeCell(l.code);
      ws.getCell(r, 1).numFmt = '@';
      ws.getCell(r, 2).value = sanitizeCell(l.description);
      ws.getCell(r, 3).value = sanitizeCell(g.sheet);
      ws.getCell(r, 4).value = g.floor ? sanitizeCell(floorName(input, g.floor)) : '';
      ws.getCell(r, 5).value = g.count;
      if (i === 0 && l.reasons?.length) ws.getCell(r, 6).value = sanitizeCell(l.reasons.join('; '));
      if (g.detectionIds?.length) {
        const ids = g.detectionIds.slice(0, 50).join(', ');
        ws.getCell(r, 7).value = sanitizeCell(g.detectionIds.length > 50 ? `${ids}, … (+${g.detectionIds.length - 50})` : ids);
      }
      if (g.linkGroups?.length) {
        const c = ws.getCell(r, 8);
        c.value = sanitizeCell(g.linkGroups.map(linkGroupText).join('\n'));
        c.alignment = { wrapText: true, vertical: 'top' };
      }
      r++;
    });
  }
}
