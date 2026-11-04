import {
  CONFIDENCE_HE,
  displayDescription,
  effectiveQty,
  type BoqDocumentColumnKey,
  type BoqDocumentModel,
  type BoqDocumentRow,
  type BoqLine,
  type BoqTemplate,
  type ConfidenceLevel,
  lineOrigin,
  LINE_ORIGIN_HE,
  NEEDS_INPUT_HE,
} from '@kamutan/contracts';
import ExcelJS from 'exceljs';
import {
  buildBoqDocument,
  byCode,
  CHAPTER_TOTAL,
  CONFIDENCE_TITLE,
  confidenceLabel,
  DEFAULT_FLOOR_NAMES,
  DRAFT_NOTE,
  floorNameOf,
  linesInChapters,
  NOTES_TITLE,
  qtyFormat,
  STATUS_TITLE,
  statusLabel,
  warningText,
} from './boq-document';

// Layout constants live in boq-document.ts since Sprint 7; re-exported for the existing importers.
export { CHAPTER_TOTAL, CONFIDENCE_TITLE, DEFAULT_FLOOR_NAMES, DRAFT_NOTE, NOTES_TITLE, qtyFormat, STATUS_TITLE, warningText };
export { groupByChapter } from './boq-document';

/**
 * Excel export of a project BOQ in the client's format (Sprint 3 brief "Excel export"; UX §export; SEC-39).
 *  - Sheet "כמויות": written FROM the `BoqDocumentModel` (Sprint 7, boq-document.ts) — the same object
 *    `GET …/boq/document` returns, so the preview and the file cannot drift: optional warning row, template title rows,
 *    header (template columns + optional "רמת ביטחון" + "סטטוס" at the end = far left in RTL), per chapter: header row,
 *    "הערות:" + numbered notes, line rows (code as TEXT, empty unit price, total = qty × price formula), "סה"כ" row
 *    (SUM formula); grand totals before/after VAT.
 *  - Sheet "פירוט לפי קומה": quantity per floor (+ SUM formula) and the final (override-aware) quantity.
 *  - Sheet "פירוט לפי חדר" (Stage 10, A-pipeline-12): one row per (line, room) from the worker's `byRoom` + a SUM per
 *    line (= the line qty); a line without `byRoom` gets one row "—".
 *  - Sheet "ראיות": line → sheet / floor / number of items on the drawing.
 * The secondary sheets list the document's lines (chapter filter applied) with the displayed (renamed) description.
 * Every text cell coming from users / OCR / templates is passed through `sanitizeCell` (formula injection).
 */

export const MAIN_SHEET = 'כמויות';
export const FLOOR_SHEET = 'פירוט לפי קומה';
export const EVIDENCE_SHEET = 'ראיות';
export const ROOM_SHEET = 'פירוט לפי חדר';
export const NO_ROOM = '—';
export const OUTSIDE_ROOMS = 'מחוץ לחדרים';
export const GRAND_TOTAL = 'סה"כ כללי לא כולל מע"מ';
export const GRAND_TOTAL_VAT = 'סה"כ כללי כולל מע"מ';
export const NO_FLOOR = 'ללא קומה';
/** Currency format of the client's sample (price / total columns). */
export const CURRENCY_FMT = '"₪"\\ #,##0';

/** SEC-39: a cell starting with = + - @ TAB CR gets a leading apostrophe; control chars (except \n) are dropped. */
export function sanitizeCell(v: string): string {
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

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
  // --- Sprint 7 (export dialog = preview options; defaults = the Sprint 3–6 layout) ---
  includeConfidence?: boolean;
  chapters?: readonly string[] | null;
  projectId?: string;
  buildId?: string | null;
  blockExportOnRed?: boolean;
}

const floorName = (input: ExcelInput, f: string) => floorNameOf(input.floorNames, f);

type ColKey = BoqDocumentColumnKey;

const LEVEL_COLOR: Record<ConfidenceLevel, string> = { green: 'FF1B7F5A', yellow: 'FFB26B00', red: 'FFC2410C' };
const thin = { style: 'thin' as const, color: { argb: 'FF9CA3AF' } };
const BORDER = { top: thin, bottom: thin, left: thin, right: thin };

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

export function colLetter(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/** The document model of an export input (the preview endpoint builds the same with the same options). */
export function documentOf(input: ExcelInput): BoqDocumentModel {
  return buildBoqDocument({
    projectId: input.projectId ?? 'project',
    projectName: input.projectName,
    ...(input.orgName !== undefined ? { orgName: input.orgName } : {}),
    date: input.date,
    template: input.template,
    lines: input.lines,
    split: input.split,
    markDraft: input.markDraft,
    includeConfidence: input.includeConfidence ?? true,
    chapters: input.chapters ?? null,
    ...(input.vatRate !== undefined ? { vatRate: input.vatRate } : {}),
    ...(input.floorNames ? { floorNames: input.floorNames } : {}),
    buildId: input.buildId ?? null,
    ...(input.blockExportOnRed !== undefined ? { blockExportOnRed: input.blockExportOnRed } : {}),
  });
}

/** xlsx of the export. `doc` = the model to write (the service passes the one it built; else built from `input`). */
export async function buildBoqWorkbook(input: ExcelInput, doc: BoqDocumentModel = documentOf(input)): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Kamutan';
  wb.created = input.date;
  wb.modified = input.date;

  const shown = linesInChapters(input.template, input.lines, doc.options.chapters).map((l) => ({ ...l, description: displayDescription(l) }));
  const rest: ExcelInput = { ...input, lines: shown };

  writeMainSheet(wb, doc);
  buildFloorSheet(wb, rest);
  buildRoomSheet(wb, rest);
  buildEvidenceSheet(wb, rest);

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

/** Main sheet "כמויות", cell by cell from the document model (row order documented in contracts boq-document.ts). */
export function writeMainSheet(wb: ExcelJS.Workbook, doc: BoqDocumentModel): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(MAIN_SHEET, { views: [{ rightToLeft: true }], properties: { defaultRowHeight: 18 } });
  const cols = doc.columns;
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

  let titleIdx = 0;
  for (const t of doc.titleRows) {
    if (t.kind === 'warning') {
      fullRow(t.text, { font: { bold: true, color: { argb: 'FFC2410C' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEDD5' } } }, 32);
    } else if (t.kind === 'title') {
      fullRow(t.text, { font: { bold: true, size: titleIdx === 0 ? 14 : 12 } });
      titleIdx++;
    } else {
      fullRow(t.text, { font: { bold: true, color: { argb: 'FFC2410C' } } });
    }
  }

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
  for (const ch of doc.chapters) {
    const h = ws.getCell(r, textCol);
    h.value = sanitizeCell(ch.title);
    h.style = { font: { bold: true, underline: true, size: 12 } };
    r++;
    let first = -1;
    let notesHeader = true;
    for (const row of ch.rows) {
      if (row.kind === 'note') {
        const c = ws.getCell(r, textCol);
        if (notesHeader) {
          c.value = NOTES_TITLE;
          c.style = { font: { bold: true } };
          notesHeader = false;
        } else {
          c.value = sanitizeCell(row.description);
          c.style = { alignment: { wrapText: true, vertical: 'top' } };
        }
        r++;
      } else if (row.kind === 'line') {
        if (first < 0) first = r;
        writeLineRow(ws, r, row, col, qtyCol, priceCol, totalCol);
        r++;
      } else {
        const last = r - 1;
        const label = ws.getCell(r, textCol);
        label.value = CHAPTER_TOTAL;
        label.style = { font: { bold: true } };
        if (totalCol) {
          const L = colLetter(totalCol);
          const t = ws.getCell(r, totalCol);
          t.value = { formula: `SUM(${L}${first < 0 ? r : first}:${L}${last})`, result: row.total ?? 0 };
          t.style = { font: { bold: true }, numFmt: CURRENCY_FMT, border: { top: thin } };
          chapterTotals.push(`${L}${r}`);
        }
        r += 2; // blank row between chapters
      }
    }
  }

  if (totalCol) {
    const L = colLetter(totalCol);
    ws.getCell(r, textCol).value = GRAND_TOTAL;
    ws.getCell(r, textCol).style = { font: { bold: true } };
    ws.getCell(r, totalCol).value = { formula: chapterTotals.length ? `SUM(${chapterTotals.join(',')})` : '0', result: doc.totals.beforeVat };
    ws.getCell(r, totalCol).style = { font: { bold: true }, numFmt: CURRENCY_FMT };
    const before = `${L}${r}`;
    r++;
    ws.getCell(r, textCol).value = GRAND_TOTAL_VAT;
    ws.getCell(r, textCol).style = { font: { bold: true } };
    ws.getCell(r, totalCol).value = { formula: `${before}*(1+${doc.totals.vatRate})`, result: doc.totals.afterVat };
    ws.getCell(r, totalCol).style = { font: { bold: true }, numFmt: CURRENCY_FMT };
  }
  return ws;
}

function writeLineRow(
  ws: ExcelJS.Worksheet,
  r: number,
  row: BoqDocumentRow,
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
  set('code', sanitizeCell(row.code ?? ''), { numFmt: '@', alignment: { horizontal: 'center', vertical: 'top' } });
  set('description', sanitizeCell(row.description));
  set('unit', sanitizeCell(row.unit ?? ''), { alignment: { horizontal: 'center', vertical: 'top' } });
  // Sprint 6: a line still waiting for a manual quantity ("להשלמה ידנית") has qty null → EMPTY cell + a note.
  set('qty', row.qty, { numFmt: row.qtyFormat === 'decimal2' ? '0.00' : 'General', alignment: { horizontal: 'center', vertical: 'top' } });
  if (row.cellNote) ws.getCell(r, qtyCol).note = sanitizeCell(row.cellNote);
  set('unitPrice', row.price, { numFmt: CURRENCY_FMT });
  if (totalCol) {
    const Q = colLetter(qtyCol);
    const formula = priceCol ? `${Q}${r}*${colLetter(priceCol)}${r}` : '0';
    set('total', { formula, result: row.total ?? 0 }, { numFmt: CURRENCY_FMT });
  }
  const conf = confidenceLabel(row);
  if (conf && row.level) set('confidence', conf, { font: { bold: true, color: { argb: LEVEL_COLOR[row.level] } }, alignment: { horizontal: 'center', vertical: 'top' } });
  // Stage 10 (A-API-06): an approved line whose qty changed since the approval is exported as "נבדק" (effectiveStatus).
  const st = statusLabel(row);
  if (st) set('status', st, { alignment: { horizontal: 'center', vertical: 'top' } });
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
    const fmt = qtyFormat(l.unit);
    floorCols.forEach((f, j) => {
      if (per[f] !== undefined) {
        ws.getCell(r, firstFloor + j).value = per[f] as number;
        ws.getCell(r, firstFloor + j).numFmt = fmt;
      }
    });
    ws.getCell(r, sumCol).value = floorCols.length
      ? { formula: `SUM(${colLetter(firstFloor)}${r}:${colLetter(sumCol - 1)}${r})`, result: Object.values(per).reduce((a, b) => a + b, 0) }
      : 0;
    ws.getCell(r, sumCol).numFmt = fmt;
    ws.getCell(r, sumCol + 1).value = effectiveQty(l);
    ws.getCell(r, sumCol + 1).numFmt = fmt;
    ws.getCell(r, sumCol + 2).value = CONFIDENCE_HE[l.level];
    ws.getCell(r, sumCol + 2).font = { color: { argb: LEVEL_COLOR[l.level] }, bold: true };
  });
}

function buildRoomSheet(wb: ExcelJS.Workbook, input: ExcelInput): void {
  const ws = wb.addWorksheet(ROOM_SHEET, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  const head = ['סעיף', 'תאור העבודה', 'יחידה', 'קומה', 'חדר', 'כמות'];
  ws.columns = head.map((_, i) => ({ width: i === 1 ? 50 : i === 4 ? 22 : 12 }));
  head.forEach((t, i) => {
    const c = ws.getCell(1, i + 1);
    c.value = sanitizeCell(t);
    c.style = { font: { bold: true }, border: BORDER, alignment: { horizontal: 'center', wrapText: true }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } } };
  });
  let r = 2;
  for (const l of [...input.lines].sort(byCode)) {
    const fmt = qtyFormat(l.unit);
    const rooms = l.byRoom && l.byRoom.length ? l.byRoom : null;
    const first = r;
    const rows = rooms ?? [{ floor: l.floor ?? null, name: null, roomId: null, qty: l.qty }];
    for (const room of rows) {
      ws.getCell(r, 1).value = sanitizeCell(l.code);
      ws.getCell(r, 1).numFmt = '@';
      ws.getCell(r, 2).value = sanitizeCell(l.description);
      ws.getCell(r, 3).value = sanitizeCell(l.unit);
      ws.getCell(r, 4).value = room.floor ? sanitizeCell(floorName(input, room.floor)) : '';
      ws.getCell(r, 5).value = sanitizeCell(!rooms ? NO_ROOM : room.name || (room.roomId ? room.roomId : OUTSIDE_ROOMS));
      ws.getCell(r, 6).value = room.qty;
      ws.getCell(r, 6).numFmt = fmt;
      r++;
    }
    if (rooms) {
      ws.getCell(r, 2).value = sanitizeCell(`${CHAPTER_TOTAL} ${l.code}`);
      ws.getCell(r, 2).font = { bold: true };
      ws.getCell(r, 6).value = { formula: `SUM(F${first}:F${r - 1})`, result: rooms.reduce((a, x) => a + x.qty, 0) };
      ws.getCell(r, 6).numFmt = fmt;
      ws.getCell(r, 6).font = { bold: true };
      r++;
    }
  }
}

function buildEvidenceSheet(wb: ExcelJS.Workbook, input: ExcelInput): void {
  const ws = wb.addWorksheet(EVIDENCE_SHEET, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  const head = ['סעיף', 'תאור העבודה', 'גיליון', 'קומה', 'כמות בשרטוט', 'סיבות', 'מזהי פריטים', 'קבוצות מפסק↔גוף תאורה', ORIGIN_TITLE];
  ws.columns = [{ width: 8 }, { width: 45 }, { width: 30 }, { width: 14 }, { width: 12 }, { width: 50 }, { width: 40 }, { width: 60 }, { width: 22 }];
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
      ws.getCell(r, 5).numFmt = qtyFormat(l.unit);
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
      if (i === 0) ws.getCell(r, 9).value = sanitizeCell(originText(l));
      r++;
    });
  }
}

/** Sprint 6: column "מקור" of "ראיות" — where the line's quantity comes from (+ "להשלמה ידנית"). */
export const ORIGIN_TITLE = 'מקור';
export const originText = (l: Pick<BoqLine, 'origin' | 'needsInput'>): string => `${LINE_ORIGIN_HE[lineOrigin(l)]}${l.needsInput ? ` – ${NEEDS_INPUT_HE}` : ''}`;
