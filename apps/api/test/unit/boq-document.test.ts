/**
 * Sprint 7 (owner request 1): the preview model and the xlsx main sheet agree ROW BY ROW — the xlsx is written from
 * the model (fidelity by construction); these tests read the written file back and walk both in lockstep.
 */
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { BoqDocumentModelSchema, BOQ_STATUS_HE, CONFIDENCE_HE, vatLabelHe, type BoqDocumentModel, type BoqLine, type BoqTemplate } from '@kamutan/contracts';
import { toBoqLine } from '../../src/db/boq-docs';
import { buildBoqDocument, documentWarnings, NOTES_TITLE } from '../../src/boq/boq-document';
import { buildBoqWorkbook, CURRENCY_FMT, documentOf, GRAND_TOTAL, GRAND_TOTAL_VAT, MAIN_SHEET, sanitizeCell, type ExcelInput } from '../../src/boq/excel';
import { NOAH_FLOORS, noahLines } from '../fixtures/noah-boq';
import { SAMPLE_BOQ_TEMPLATE } from '../fixtures/sample-template';

const template: BoqTemplate = structuredClone(SAMPLE_BOQ_TEMPLATE);
const lines = (): BoqLine[] => noahLines().map((l) => toBoqLine(l.id, { ...l } as Record<string, unknown>));
const floorNames: Record<string, string> = Object.fromEntries(NOAH_FLOORS.map((f) => [f, `קומה ${f}`]));
const input = (over: Partial<ExcelInput> = {}): ExcelInput => ({
  projectName: 'בית משפחת נח',
  orgName: 'משרד',
  date: new Date('2026-11-04T10:00:00Z'),
  template,
  lines: lines(),
  split: 'summed',
  markDraft: false,
  evidence: new Map(),
  floorNames,
  ...over,
});

async function mainSheet(inp: ExcelInput, doc: BoqDocumentModel): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await buildBoqWorkbook(inp, doc)) as unknown as ArrayBuffer);
  return wb.getWorksheet(MAIN_SHEET) as ExcelJS.Worksheet;
}

const text = (v: ExcelJS.CellValue): string | null => (v === null || v === undefined ? null : typeof v === 'object' && 'formula' in (v as object) ? null : String(v));

/** Walks the model in the documented xlsx row order and asserts every row against the sheet. */
function assertAgreement(ws: ExcelJS.Worksheet, doc: BoqDocumentModel): number {
  const col = new Map(doc.columns.map((c, i) => [c.key, i + 1]));
  const textCol = col.get('description') ?? 1;
  const cell = (r: number, k: string) => ws.getCell(r, col.get(k as never) as number);
  let r = 1;
  for (const t of doc.titleRows) expect(ws.getCell(r++, 1).value, `title row ${r - 1}`).toBe(sanitizeCell(t.text));
  doc.columns.forEach((c, i) => expect(ws.getCell(r, i + 1).value).toBe(c.title));
  expect(ws.columnCount).toBe(doc.columns.length);
  r++;
  let lineRows = 0;
  for (const ch of doc.chapters) {
    expect(ws.getCell(r++, textCol).value, `chapter ${ch.code}`).toBe(ch.title);
    for (const row of ch.rows) {
      if (row.kind === 'note') {
        expect(ws.getCell(r, textCol).value).toBe(row.description === NOTES_TITLE ? NOTES_TITLE : sanitizeCell(row.description));
        r++;
      } else if (row.kind === 'line') {
        expect(cell(r, 'code').value, `row ${r}`).toBe(row.code);
        expect(cell(r, 'code').numFmt).toBe('@');
        expect(cell(r, 'description').value).toBe(sanitizeCell(row.description));
        expect(cell(r, 'unit').value).toBe(row.unit);
        expect(cell(r, 'qty').value ?? null).toBe(row.qty);
        expect(cell(r, 'qty').numFmt ?? 'General').toBe(row.qtyFormat === 'decimal2' ? '0.00' : 'General');
        expect(text(cell(r, 'qty').note as never) ?? null).toBe(row.cellNote ? sanitizeCell(row.cellNote) : null);
        expect(cell(r, 'unitPrice').value ?? null).toBe(row.price);
        const tot = cell(r, 'total').value as { formula: string; result: number };
        expect(tot.formula).toMatch(new RegExp(`^[A-Z]+${r}\\*[A-Z]+${r}$`));
        expect(tot.result ?? 0).toBe(row.total); // exceljs reads a 0 cached result back as undefined
        if (doc.options.includeConfidence) {
          expect(cell(r, 'confidence').value).toBe(CONFIDENCE_HE[row.level as 'green']);
          expect(cell(r, 'status').value).toBe(BOQ_STATUS_HE[row.status as 'draft']);
        } else {
          expect(row.level).toBeUndefined();
        }
        lineRows++;
        r++;
      } else {
        expect(ws.getCell(r, textCol).value).toBe(row.description);
        const sum = cell(r, 'total').value as { formula: string; result: number };
        expect(sum.formula).toMatch(/^SUM\(/);
        expect(sum.result ?? 0).toBe(ch.subtotal);
        expect(cell(r, 'total').numFmt?.replace(/\\/g, '')).toBe(CURRENCY_FMT.replace(/\\/g, ''));
        r += 2;
      }
    }
  }
  expect(ws.getCell(r, textCol).value).toBe(GRAND_TOTAL);
  expect((cell(r, 'total').value as { result?: number }).result ?? 0).toBe(doc.totals.beforeVat);
  // Sprint 8: before VAT → "מע"מ 18%" (before × rate) → after VAT (before + VAT), formulas with the model's results.
  const L = (cell(r, 'total') as ExcelJS.Cell).address.replace(/\d+$/, '');
  expect(ws.getCell(r + 1, textCol).value).toBe(vatLabelHe(doc.totals.vatRate));
  expect((cell(r + 1, 'total').value as { formula: string }).formula).toBe(`${L}${r}*${doc.totals.vatRate}`);
  expect((cell(r + 1, 'total').value as { result?: number }).result ?? 0).toBe(doc.totals.vat);
  expect(ws.getCell(r + 2, textCol).value).toBe(GRAND_TOTAL_VAT);
  expect((cell(r + 2, 'total').value as { formula: string }).formula).toBe(`${L}${r}+${L}${r + 1}`);
  expect((cell(r + 2, 'total').value as { result?: number }).result ?? 0).toBe(doc.totals.afterVat);
  expect(ws.rowCount).toBe(r + 2);
  return lineRows;
}

describe('BoqDocumentModel ↔ xlsx main sheet (row by row)', () => {
  it.each([
    ['summed, confidence', {}],
    ['byFloor split', { split: 'byFloor' as const }],
    ['no confidence / status columns', { includeConfidence: false }],
    ['draft + one chapter only', { markDraft: true, chapters: ['04'] }],
  ])('%s', async (_n, over) => {
    const inp = input(over);
    const doc = BoqDocumentModelSchema.parse(documentOf(inp));
    const ws = await mainSheet(inp, doc);
    const n = assertAgreement(ws, doc);
    expect(n).toBe(doc.chapters.reduce((a, c) => a + c.rows.filter((x) => x.kind === 'line').length, 0));
    if ('chapters' in over) expect(doc.chapters.map((c) => c.code)).toEqual(['04']);
  });

  it('the preview endpoint model (service path) equals the one the writer builds for the same options', () => {
    const inp = input({ split: 'byFloor' });
    const a = documentOf(inp);
    const b = buildBoqDocument({ projectId: 'project', projectName: inp.projectName, orgName: 'משרד', date: inp.date, template, lines: inp.lines, split: 'byFloor', markDraft: false, includeConfidence: true, chapters: null, floorNames, buildId: null });
    expect(b).toEqual(a);
  });

  it('renamed lines + formula injection: the model holds the raw text, the xlsx the escaped one', async () => {
    const ls = lines();
    const target = ls.find((l) => l.code === '4.10') as BoqLine;
    target.descriptionOverride = '=HYPERLINK("http://evil","x")';
    const inp = input({ lines: ls });
    const doc = documentOf(inp);
    const row = doc.chapters.flatMap((c) => c.rows).find((x) => x.lineId === target.id);
    expect(row).toMatchObject({ description: '=HYPERLINK("http://evil","x")', descriptionOverridden: true });
    const ws = await mainSheet(inp, doc);
    assertAgreement(ws, doc);
    let found = false;
    ws.eachRow((r) => {
      if (r.getCell(1).value === '4.10') {
        expect(r.getCell(2).value).toBe(`'=HYPERLINK("http://evil","x")`);
        found = true;
      }
    });
    expect(found).toBe(true);
    // the other sheets show the rename too (escaped)
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildBoqWorkbook(inp, doc)) as unknown as ArrayBuffer);
    for (const s of wb.worksheets.slice(1)) {
      const texts: unknown[] = [];
      s.eachRow((r) => texts.push(r.getCell(2).value));
      expect(texts, s.name).toContain(`'=HYPERLINK("http://evil","x")`);
    }
  });

  it('needsInput line: empty qty + note; warnings = export gate over all lines', () => {
    const ls = lines();
    const l = ls[0] as BoqLine;
    Object.assign(l, { needsInput: true, qty: 0, level: 'red', status: 'draft' });
    const doc = documentOf(input({ lines: ls }));
    const row = doc.chapters.flatMap((c) => c.rows).find((x) => x.lineId === l.id);
    expect(row).toMatchObject({ qty: null, cellNote: 'להשלמה ידנית', needsInput: true });
    expect(doc.warnings.map((w) => w.kind)).toEqual(expect.arrayContaining(['red', 'unapproved', 'needsInput']));
    expect(doc.exportBlocked).toBe(true);
    // Sprint 8: + `unpriced` over the document's lines (never blocks); the gate part is over every line.
    const gate = (w: typeof doc.warnings) => w.filter((x) => x.kind !== 'unpriced');
    expect(documentWarnings(ls)).toEqual(gate(doc.warnings));
    expect(doc.warnings.find((w) => w.kind === 'unpriced')?.count).toBe(ls.length);
    expect(documentOf(input({ lines: ls, blockExportOnRed: false })).exportBlocked).toBe(false);
    // the chapter filter changes the document, not the gate
    const other = documentOf(input({ lines: ls, chapters: ['999'] }));
    expect(other.chapters).toHaveLength(0);
    expect(gate(other.warnings)).toEqual(gate(doc.warnings));
  });
});
