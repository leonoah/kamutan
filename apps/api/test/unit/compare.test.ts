import { describe, expect, it } from 'vitest';
import { BoqComparisonSchema, type BoqLinesSnapshot, type BoqLinesSnapshotLine } from '@kamutan/contracts';
import { buildCompareWorkbook, compareSnapshots } from '../../src/boq/compare';
import ExcelJS from 'exceljs';

const L = (o: Partial<BoqLinesSnapshotLine> & { lineId: string; code: string }): BoqLinesSnapshotLine => ({ chapter: '04', description: o.code, unit: "יח'", qty: 1, price: null, ...o });
const snap = (buildId: string, lines: BoqLinesSnapshotLine[], sheetVersions?: Record<string, string>): BoqLinesSnapshot => ({ schema: 'kamutan.boq-lines/1', projectId: 'p1', buildId, createdAt: '2026-11-07T00:00:00.000Z', lines, ...(sheetVersions ? { sheetVersions } : {}) });

describe('compareSnapshots', () => {
  const from = snap(
    'b0',
    [
      L({ lineId: 'l1', code: '4.10', qty: 4, price: 10, byFloor: { '0': 2, '1': 2 }, sourceVersions: [{ sheetId: 's1', versionId: 'v1' }] }),
      L({ lineId: 'l2', code: '4.11', qty: 1, price: 50, priceSource: 'library' }),
      L({ lineId: 'l3', code: '4.12', qty: 3 }),
      L({ lineId: 'old', code: '4.13', qty: 2, price: 5 }),
      L({ lineId: 'l5', code: '4.14', qty: 7, price: 1 }),
    ],
    { s1: 'v1', s2: 'v9' },
  );
  const to = snap(
    'b1',
    [
      L({ lineId: 'l1', code: '4.10', qty: 6, price: 10, byFloor: { '0': 2, '1': 4 }, sourceVersions: [{ sheetId: 's1', versionId: 'v2' }] }),
      L({ lineId: 'l2', code: '4.11', qty: 1, price: 55, priceSource: 'override', priceOverride: 55 }),
      L({ lineId: 'new', code: '4.13', qty: 2, price: 5 }), // same (code, unit) as `old` → matched, unchanged
      L({ lineId: 'l4', code: '4.20', qty: 1, price: 100, sourceVersions: [{ sheetId: 's3', versionId: 'v1' }] }),
      L({ lineId: 'l5', code: '4.14', qty: 7, price: 1 }),
    ],
    { s1: 'v2', s3: 'v1' },
  );
  const cmp = compareSnapshots({ projectId: 'p1', base: 'previous', from, to, fromAt: null, toAt: null, titles: new Map([['s1', 'חשמל קומה א']]) });

  it('kinds, Δqty / Δ₪, (code, unit) fallback match, summary', () => {
    expect(BoqComparisonSchema.safeParse(cmp).success).toBe(true);
    expect(cmp.items.map((i) => [i.lineId, i.kind])).toEqual([
      ['l1', 'changed'],
      ['l2', 'changed'],
      ['l3', 'removed'],
      ['l4', 'added'],
    ]);
    expect(cmp.summary).toEqual({ added: 1, removed: 1, changed: 2, unchanged: 2, fromTotal: 107, toTotal: 232, deltaTotal: 125 });
    const l1 = cmp.items[0]!;
    expect(l1).toMatchObject({ fromQty: 4, toQty: 6, deltaQty: 2, fromTotal: 40, toTotal: 60, deltaTotal: 20, changes: ['qty'], byFloor: [{ floor: '1', fromQty: 2, toQty: 4, deltaQty: 2 }] });
    expect(cmp.items.find((i) => i.lineId === 'l3')).toMatchObject({ fromQty: 3, toQty: null, deltaQty: -3, deltaTotal: null });
  });

  it('causes: sheet version (title), price override vs library price, other', () => {
    expect(cmp.items[0]!.causes).toEqual([{ kind: 'sheet', sheetId: 's1', title: 'חשמל קומה א', fromVersionId: 'v1', toVersionId: 'v2' }]);
    expect(cmp.items[1]!.causes).toEqual([{ kind: 'price_override' }]);
    expect(cmp.items.find((i) => i.lineId === 'l4')!.causes).toEqual([{ kind: 'sheet', sheetId: 's3', title: null, fromVersionId: null, toVersionId: 'v1' }]);
    expect(cmp.items.find((i) => i.lineId === 'l3')!.causes).toEqual([{ kind: 'other' }]);
    expect(cmp.sheetChanges.map((s) => [s.sheetId, s.kind])).toEqual([
      ['s1', 'revised'],
      ['s2', 'removed'],
      ['s3', 'added'],
    ]);
    const lib = compareSnapshots({ projectId: 'p1', base: 'explicit', from: snap('a', [L({ lineId: 'x', code: '1', price: 1, priceSource: 'library' })]), to: snap('b', [L({ lineId: 'x', code: '1', price: 2, priceSource: 'library' })]), fromAt: null, toAt: null });
    expect(lib.items[0]!.causes).toEqual([{ kind: 'library_price' }]);
  });

  it('a line kept at qty 0 without sources (obsolete placeholder) counts as removed, as in the worker reference', () => {
    const c = compareSnapshots({
      projectId: 'p1',
      base: 'explicit',
      from: snap('a', [L({ lineId: 'x', code: '1', qty: 3, sourceVersions: [{ sheetId: 's', versionId: 'v' }] })]),
      to: snap('b', [L({ lineId: 'x', code: '1', qty: 0 })]),
      fromAt: null,
      toAt: null,
    });
    expect(c.items.map((i) => [i.kind, i.deltaQty])).toEqual([['removed', -3]]);
  });

  it('Excel: one row per item, Δ and totals as formulas, Hebrew kind / cause text, formula injection escaped', async () => {
    const evil = compareSnapshots({ projectId: 'p1', base: 'explicit', from: snap('a', []), to: snap('b', [L({ lineId: 'x', code: '1.1', description: '=HYPERLINK("x")', qty: 2, price: 3 })]), fromAt: null, toAt: null });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildCompareWorkbook(evil, 'פרויקט', new Date())) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('תוספות ושינויים') as ExcelJS.Worksheet;
    const r = ws.getRow(5);
    expect([r.getCell(1).value, r.getCell(2).value, r.getCell(4).value, r.getCell(13).value]).toEqual(['1.1', `'=HYPERLINK("x")`, 'נוסף', 'שינוי בחישוב']);
    expect(r.getCell(11).formula).toBe('N(F5)*N(I5)');
    expect((r.getCell(12).value as { result: number }).result).toBe(6);
  });
});
