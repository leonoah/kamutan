/**
 * Sprint 8 (API): prices (library price + bulk + audit, line priceOverride, project discount / markup, org VAT, totals
 * in GET boq / BoqDocumentModel / Excel with formulas, "ללא מחיר" warnings, share "הצג מחירים", price import mode +
 * report audit), version comparison (GET …/boq/compare + Excel "תוספות ושינויים") and housekeeping deletes (sheet set:
 * editor; project: admin + MFA + typed name) with quota release, link revocation, object removal and audit.
 */
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApplyImportPricesResponseSchema,
  BoqBuildListSchema,
  BoqComparisonSchema,
  BoqCompareExportResponseSchema,
  BoqDocumentModelSchema,
  BoqViewSchema,
  BulkLibraryPriceResponseSchema,
  COMPARE_NO_SNAPSHOT_HE,
  COMPARE_SHEET_NAME,
  CreateLibraryImportResponseSchema,
  CreateShareLinkResponseSchema,
  DeleteProjectResponseSchema,
  DeleteSheetSetResponseSchema,
  ExportBoqResponseSchema,
  fsPaths,
  itemIdFor,
  ItemLibraryItemSchema,
  LibraryImportViewSchema,
  LineHistoryResponseSchema,
  PatchBoqLineResponseSchema,
  PatchProjectPricingResponseSchema,
  PROJECT_DELETE_MISMATCH_HE,
  PublicShareBoqSchema,
  PublicShareMetaSchema,
  storagePaths,
  type BoqLine,
} from '@kamutan/contracts';
import type { Doc } from '../../src/db/mappers';
import { GRAND_TOTAL, GRAND_TOTAL_VAT, LINES_TOTAL, MAIN_SHEET } from '../../src/boq/excel';
import { SAMPLE } from '../support/helpers';
import { xlsxBytes } from '../support/spreadsheets';
import { det, seedSheet } from '../support/review-fixtures';
import { auditsOf, createWorld, type World } from '../acceptance/support/world';

describe('Sprint 8 e2e (API)', () => {
  let w: World;
  const P = () => `/api/v1/projects/${w.A.projectId}`;
  const as = (r: 'viewer' | 'reviewer' | 'editor' | 'admin') => w.auth(w.A.uid(r));
  const items: Record<string, string> = {};
  const view = async () => BoqViewSchema.parse((await w.http.get(`${P()}/boq`).set(as('viewer'))).body);
  const line = async (id: string): Promise<BoqLine> => (await view()).items.find((l) => l.id === id) as BoqLine;
  const loadXlsx = async (url: string, store: Map<string, Buffer>) => {
    const path = decodeURI(new URL(url).pathname.replace(/^\/test-bucket\//, ''));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(store.get(path) as unknown as ArrayBuffer);
    return wb;
  };

  beforeAll(async () => {
    w = await createWorld();
    // library items for the lines of the world (exact code + description → exact price match)
    for (const [code, description] of [
      ['4.01', 'שקע כפול'],
      ['4.02', 'שקע מוגן מים'],
      ['4.03', 'נקודת מאור'],
    ] as const) {
      const r = await w.http.post('/api/v1/library/items').set(as('editor')).send({ orgId: w.A.orgId, code, chapter: '04', description, unit: "יח'" });
      expect([201, 409], JSON.stringify(r.body)).toContain(r.status); // 409: the default library already has it
      items[code] = itemIdFor(code, description);
    }
  });
  afterAll(async () => {
    await w.t.app.close();
  });

  // ------------------------------------------------------------------ library prices
  describe('library prices', () => {
    it('PATCH item price (editor): stored as manual with by / at; viewer / reviewer 403; audit with from → to', async () => {
      const r = await w.http.patch(`/api/v1/library/items/${items['4.01']}?orgId=${w.A.orgId}`).set(as('editor')).send({ price: 120 });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const item = ItemLibraryItemSchema.parse(r.body);
      expect(item.price).toMatchObject({ amount: 120, currency: 'ILS', source: 'manual', by: w.A.uid('editor') });
      expect(item.price?.updatedAt).toBeTruthy();
      for (const who of ['viewer', 'reviewer'] as const) expect((await w.http.patch(`/api/v1/library/items/${items['4.01']}?orgId=${w.A.orgId}`).set(as(who)).send({ price: 1 })).status).toBe(403);
      for (const price of [-1, 'x', 1e12]) expect((await w.http.patch(`/api/v1/library/items/${items['4.01']}?orgId=${w.A.orgId}`).set(as('editor')).send({ price })).status).toBe(400);
      const ev = auditsOf(w.t, w.A.orgId).filter((e) => e.entity === 'itemLibrary' && e.entityId === items['4.01'] && (e.after as Doc).price).at(-1);
      expect((ev?.after as Doc).price).toEqual({ from: null, to: 120, source: 'manual' });
      const page = await w.http.get(`/api/v1/orgs/${w.A.orgId}/audit?entity=itemLibrary`).set(as('admin'));
      expect(JSON.stringify(page.body)).toContain('מחיר ללא מחיר → ₪120');
    });

    it('bulk prices: updated / unchanged / not_found in request order, one audit event per change (shared batchId); priced filter', async () => {
      const r = await w.http
        .post('/api/v1/library/prices')
        .set(as('editor'))
        .send({ orgId: w.A.orgId, items: [{ itemId: items['4.02'], amount: 80 }, { itemId: items['4.01'], amount: 120 }, { itemId: 'it_nope', amount: 5 }, { itemId: items['4.03'], amount: 45.5 }] });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const body = BulkLibraryPriceResponseSchema.parse(r.body);
      expect(body.updated.map((u) => [u.itemId, u.from, u.to])).toEqual([
        [items['4.02'], null, 80],
        [items['4.03'], null, 45.5],
      ]);
      expect(body.skipped).toEqual([
        { itemId: items['4.01'], reason: 'unchanged' },
        { itemId: 'it_nope', reason: 'not_found' },
      ]);
      const evs = auditsOf(w.t, w.A.orgId).filter((e) => (e.after as Doc | null)?.batchId === body.batchId);
      expect(evs.map((e) => e.entityId).sort()).toEqual([items['4.02'], items['4.03']].sort());
      const priced = await w.http.get(`/api/v1/library/items?orgId=${w.A.orgId}&priced=true`).set(as('viewer'));
      expect((priced.body.items as Doc[]).map((i) => i.id).sort()).toEqual([items['4.01'], items['4.02'], items['4.03']].sort());
      expect((await w.http.post('/api/v1/library/prices').set(as('reviewer')).send({ orgId: w.A.orgId, items: [{ itemId: items['4.01'], amount: 1 }] })).status).toBe(403);
      expect((await w.http.post('/api/v1/library/prices').set(as('editor')).send({ orgId: w.A.orgId, items: [{ itemId: items['4.01'], amount: 1 }, { itemId: items['4.01'], amount: 2 }] })).status).toBe(400);
    });

    it('price import: mode + overwrite flag stored and published; a finished report is audited once', async () => {
      const c = CreateLibraryImportResponseSchema.parse(
        (await w.http.post('/api/v1/library/imports').set(as('editor')).send({ orgId: w.A.orgId, filename: 'priced.xlsx', sizeBytes: 1000, mode: 'prices', overwriteManualPrices: true })).body,
      );
      expect(c.import).toMatchObject({ mode: 'prices', overwriteManualPrices: true });
      w.t.boqStorage.putImport(c.storagePath, await xlsxBytes());
      const fin = await w.http.post(`/api/v1/library/imports/${c.import.id}/finalize`).set(as('editor')).send({ orgId: w.A.orgId });
      expect(fin.status, JSON.stringify(fin.body)).toBe(202);
      const job = w.t.queue.messages.find((m) => (m.data as Doc).importId === c.import.id)?.data as Doc;
      expect(job).toMatchObject({ type: 'library.import', mode: 'prices', overwriteManualPrices: true });
      // what Worker-BOQ writes when it is done (stats.prices = PriceImportReport)
      const ip = fsPaths.libraryImport(w.A.orgId, c.import.id);
      const report = { rows: 3, matched: 2, applied: 1, unchanged: 1, unmatched: 1, conflicts: 0, skippedManual: 0, overwriteManualPrices: true, unmatchedRows: [{ row: 9, code: '7.77', description: 'x', amount: 3 }], conflictRows: [] };
      w.t.repo.docs.set(ip, { ...(w.t.repo.docs.get(ip) as Doc), status: 'succeeded', stats: { items: 0, created: 0, updated: 0, templates: 0, prices: report } });
      const v1 = LibraryImportViewSchema.parse((await w.http.get(`/api/v1/library/imports/${c.import.id}?orgId=${w.A.orgId}`).set(as('viewer'))).body);
      expect(v1.stats?.prices).toMatchObject({ applied: 1, unmatched: 1 });
      expect(v1.pricesAuditedAt).toBeTruthy();
      await w.http.get(`/api/v1/library/imports/${c.import.id}?orgId=${w.A.orgId}`).set(as('viewer'));
      const evs = auditsOf(w.t, w.A.orgId).filter((e) => e.action === 'import_prices');
      expect(evs).toHaveLength(1);
      expect(evs[0]?.after).toMatchObject({ importId: c.import.id, mode: 'prices', applied: 1, unmatched: 1, overwriteManualPrices: true });
      expect(evs[0]?.actorId).toBe(w.A.uid('editor'));
    });
  });

  // ------------------------------------------------------------------ line prices + totals
  describe('BOQ prices and totals', () => {
    it('GET boq: unitPrice from the library, lineTotal = effective qty × price; lines without a price → null; totals over all lines', async () => {
      const v = await view();
      const l1 = v.items.find((l) => l.id === w.A.lines.status) as BoqLine;
      expect(l1).toMatchObject({ unitPrice: 120, unitPriceSource: 'library', lineTotal: 240 });
      const plain = v.items.find((l) => l.id === w.A.lines.plain) as BoqLine;
      expect(plain).toMatchObject({ unitPrice: null, unitPriceSource: null, lineTotal: null });
      const t = v.summary.totals;
      expect(t).toBeDefined();
      const sum = v.items.reduce((a, l) => a + (l.lineTotal ?? 0), 0);
      expect(t).toMatchObject({ currency: 'ILS', linesTotal: sum, adjustmentPct: 0, adjustment: 0, beforeVat: sum, vatRate: 0.18 });
      expect(t?.vat).toBeCloseTo(sum * 0.18, 6);
      expect(t?.unpricedLines).toBe(v.items.filter((l) => l.unitPrice === null).length);
      // the derived fields are never stored
      expect('unitPrice' in (w.t.repo.docs.get(fsPaths.boqLine(w.A.orgId, w.A.projectId, w.A.lines.status)) as Doc)).toBe(false);
    });

    it('priceOverride (editor; allowed on an approved line, approval kept); reviewer 403; history + audit; null restores the library price', async () => {
      const id = w.A.lines.approved;
      expect((await w.http.patch(`${P()}/boq/lines/${id}`).set(as('reviewer')).send({ priceOverride: 10 })).status).toBe(403);
      const r = await w.http.patch(`${P()}/boq/lines/${id}`).set(as('editor')).send({ priceOverride: 50, reason: 'הצעת ספק' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const { line: l } = PatchBoqLineResponseSchema.parse(r.body);
      expect(l).toMatchObject({ status: 'approved', priceOverride: 50, priceOverrideBy: w.A.uid('editor'), priceOverrideReason: 'הצעת ספק', unitPrice: 50, unitPriceSource: 'override', lineTotal: 300 });
      const hist = LineHistoryResponseSchema.parse((await w.http.get(`${P()}/boq/lines/${id}/history`).set(as('viewer'))).body);
      expect(hist.items.find((i) => i.action === 'price')).toMatchObject({ before: null, after: 50, reason: 'הצעת ספק', summary: 'מחיר ידני · מחיר הספרייה → ₪50' });
      const back = PatchBoqLineResponseSchema.parse((await w.http.patch(`${P()}/boq/lines/${id}`).set(as('editor')).send({ priceOverride: null })).body);
      expect(back.line).toMatchObject({ priceOverride: null, unitPrice: 45.5, unitPriceSource: 'library', status: 'approved' });
      // a rebuild keeps it (contract applyRebuild preserves priceOverride*)
      await w.http.patch(`${P()}/boq/lines/${id}`).set(as('editor')).send({ priceOverride: 50 });
      expect((await line(id)).priceOverride).toBe(50);
      for (const body of [{ priceOverride: -1 }, { priceOverride: 'x' }, { reason: 'x' }]) expect((await w.http.patch(`${P()}/boq/lines/${id}`).set(as('editor')).send(body)).status, JSON.stringify(body)).toBe(400);
    });

    it('project discount / markup (editor, audited) and org VAT (admin + MFA) flow into the totals', async () => {
      expect((await w.http.patch(`${P()}/boq/pricing`).set(as('reviewer')).send({ adjustmentPct: -10 })).status).toBe(403);
      const r = await w.http.patch(`${P()}/boq/pricing`).set(as('editor')).send({ adjustmentPct: -10 });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(PatchProjectPricingResponseSchema.parse(r.body).pricing).toMatchObject({ adjustmentPct: -10, updatedBy: w.A.uid('editor') });
      for (const adjustmentPct of [-95, 250, 'x']) expect((await w.http.patch(`${P()}/boq/pricing`).set(as('editor')).send({ adjustmentPct })).status).toBe(400);
      const s = await w.http.patch(`/api/v1/orgs/${w.A.orgId}/settings`).set(as('admin')).send({ vatRate: 0.17 });
      expect(s.status, JSON.stringify(s.body)).toBe(200);
      expect((await w.http.patch(`/api/v1/orgs/${w.A.orgId}/settings`).set(w.auth('a_admin_nomfa')).send({ vatRate: 0.18 })).status).toBe(403);
      const t = (await view()).summary.totals!;
      expect(t.adjustmentPct).toBe(-10);
      expect(t.adjustment).toBeCloseTo(-t.linesTotal / 10, 6);
      expect(t.beforeVat).toBeCloseTo(t.linesTotal * 0.9, 6);
      expect(t).toMatchObject({ vatRate: 0.17 });
      expect(t.afterVat).toBeCloseTo(t.beforeVat * 1.17, 6);
      const ev = auditsOf(w.t, w.A.orgId).filter((e) => e.action === 'update_pricing').at(-1);
      expect(ev?.after).toMatchObject({ projectId: w.A.projectId, from: 0, to: -10 });
      const project = await w.http.get(P()).set(as('viewer'));
      expect(project.body.pricing).toMatchObject({ adjustmentPct: -10 });
    });

    it('document: prices + "ללא מחיר" warning; prices=0 → empty price column, no warning', async () => {
      const doc = BoqDocumentModelSchema.parse((await w.http.get(`${P()}/boq/document`).set(as('viewer'))).body);
      const rows = doc.chapters.flatMap((c) => c.rows).filter((r) => r.kind === 'line');
      expect(rows.find((r) => r.lineId === w.A.lines.status)).toMatchObject({ price: 120, total: 240, priceSource: 'library' });
      expect(rows.find((r) => r.lineId === w.A.lines.plain)).toMatchObject({ price: null, total: 0, unpriced: true });
      expect(doc.warnings.find((x) => x.kind === 'unpriced')?.count).toBe(rows.filter((r) => r.unpriced).length);
      expect(doc.totals.adjustmentPct).toBe(-10);
      expect(doc.totals.linesTotal).toBeCloseTo(doc.chapters.reduce((a, c) => a + c.subtotal, 0), 6);
      const none = BoqDocumentModelSchema.parse((await w.http.get(`${P()}/boq/document?prices=0`).set(as('viewer'))).body);
      expect(none.chapters.flatMap((c) => c.rows).every((r) => r.price === null)).toBe(true);
      expect(none.warnings.some((x) => x.kind === 'unpriced')).toBe(false);
      expect(none.totals.linesTotal).toBe(0);
    });

    it('Excel: unit prices + "ללא מחיר" note; totals as formulas: lines → discount → before VAT → VAT → after VAT', async () => {
      const r = await w.http.post(`${P()}/boq/export`).set(as('editor')).send({});
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const wb = await loadXlsx(ExportBoqResponseSchema.parse(r.body).url, w.t.boqStorage.objects);
      const ws = wb.getWorksheet(MAIN_SHEET) as ExcelJS.Worksheet;
      const byText = (t: string) => {
        let row: ExcelJS.Row | undefined;
        ws.eachRow((x) => x.eachCell((c) => void (c.value === t && (row = x))));
        return row as ExcelJS.Row;
      };
      const r401 = byText('שקע כפול');
      expect(r401.getCell(5).value).toBe(120);
      expect(r401.getCell(6).formula).toBe(`D${r401.number}*E${r401.number}`);
      expect(byText('מפסק').getCell(5).note).toBeTruthy();
      const lines = byText(LINES_TOTAL);
      const disc = ws.getRow(lines.number + 1);
      expect(disc.getCell(2).value).toBe('הנחה 10%');
      expect(disc.getCell(6).formula).toBe(`F${lines.number}*-0.1`);
      const before = byText(GRAND_TOTAL);
      expect(before.number).toBe(lines.number + 2);
      expect(before.getCell(6).formula).toBe(`F${lines.number}+F${lines.number + 1}`);
      const vat = ws.getRow(before.number + 1);
      expect([vat.getCell(2).value, vat.getCell(6).formula]).toEqual(['מע"מ 17%', `F${before.number}*0.17`]);
      expect(byText(GRAND_TOTAL_VAT).getCell(6).formula).toBe(`F${before.number}+F${before.number + 1}`);
      const noPrices = await w.http.post(`${P()}/boq/export`).set(as('editor')).send({ includePrices: false });
      const ws2 = (await loadXlsx(noPrices.body.url as string, w.t.boqStorage.objects)).getWorksheet(MAIN_SHEET) as ExcelJS.Worksheet;
      let anyPrice = false;
      ws2.eachRow((x) => void (typeof x.getCell(5).value === 'number' && (anyPrice = true)));
      expect(anyPrice).toBe(false);
    });

    it('share link: prices hidden by default; "הצג מחירים" freezes unit prices + totals into the snapshot', async () => {
      const plainLink = CreateShareLinkResponseSchema.parse((await w.http.post(`${P()}/share-links`).set(as('editor')).send({ label: 'ללא מחירים', days: 3 })).body);
      expect(plainLink.link.showPrices).toBe(false);
      const b1 = PublicShareBoqSchema.parse((await w.http.get(`/api/v1/public/share/${plainLink.token}/boq`)).body);
      expect(b1.lines.every((l) => l.unitPrice === undefined && l.total === undefined)).toBe(true);
      expect(b1.totals ?? null).toBeNull();
      const snapPath = storagePaths.shareBoqSnapshot(w.A.orgId, w.A.projectId, plainLink.link.id);
      expect(JSON.stringify(await w.t.govStorage.readShareSnapshot(snapPath))).not.toMatch(/unitPrice|totals/);
      const priced = CreateShareLinkResponseSchema.parse((await w.http.post(`${P()}/share-links`).set(as('editor')).send({ label: 'עם מחירים', days: 3, showPrices: true })).body);
      expect(priced.link.showPrices).toBe(true);
      const b2 = PublicShareBoqSchema.parse((await w.http.get(`/api/v1/public/share/${priced.token}/boq`)).body);
      expect(b2.showPrices).toBe(true);
      expect(b2.lines.find((l) => l.id === w.A.lines.status)).toMatchObject({ unitPrice: 120, total: 240 });
      expect(b2.totals).toMatchObject({ adjustmentPct: -10, vatRate: 0.17 });
      expect(PublicShareMetaSchema.parse((await w.http.get(`/api/v1/public/share/${priced.token}/meta`)).body).link.showPrices).toBe(true);
      const ev = auditsOf(w.t, w.A.orgId).filter((e) => e.entity === 'shareLinks' && e.action === 'create').at(-1);
      expect((ev?.after as Doc).showPrices).toBe(true);
    });
  });

  // ------------------------------------------------------------------ comparison
  describe('comparison ("מה השתנה")', () => {
    it('to=b1 (stored snapshot) vs the previous build: changed line with Δqty / Δ₪ and the sheet version that caused it', async () => {
      const r = await w.http.get(`${P()}/boq/compare?to=b1`).set(as('viewer'));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const c = BoqComparisonSchema.parse(r.body);
      expect(c).toMatchObject({ base: 'previous', from: { buildId: 'b0' }, to: { buildId: 'b1' }, summary: { added: 0, removed: 0, changed: 1, unchanged: 0, fromTotal: 100, toTotal: 200, deltaTotal: 100 } });
      expect(c.items[0]).toMatchObject({ kind: 'changed', lineId: w.A.lines.status, fromQty: 1, toQty: 2, deltaQty: 1, deltaTotal: 100, changes: ['qty'] });
      expect(c.items[0]?.causes).toEqual([{ kind: 'sheet', sheetId: w.A.sheet.sheetId, title: expect.any(String), fromVersionId: 'v_old', toVersionId: w.A.sheet.versionId }]);
      expect(c.sheetChanges).toEqual([expect.objectContaining({ sheetId: w.A.sheet.sheetId, kind: 'revised' })]);
    });

    it('base=export ("since the last export") and explicit from / to; 404 unknown build, 409 build without snapshot (Hebrew)', async () => {
      const exp = BoqComparisonSchema.parse((await w.http.get(`${P()}/boq/compare?base=export&to=b1`).set(as('viewer'))).body);
      expect(exp.base).toBe('export');
      expect(exp.from.exportId).toBeTruthy();
      expect(exp.items).toEqual([]); // the last export was of b1 = the latest build
      const rev = BoqComparisonSchema.parse((await w.http.get(`${P()}/boq/compare?from=b1&to=b0`).set(as('viewer'))).body);
      expect([rev.base, rev.items[0]?.deltaQty, rev.summary.deltaTotal]).toEqual(['explicit', -1, -100]);
      expect((await w.http.get(`${P()}/boq/compare?from=nope`).set(as('viewer'))).status).toBe(404);
      w.t.repo.docs.set(fsPaths.boqBuild(w.A.orgId, w.A.projectId, 'b_old'), { status: 'succeeded', createdAt: new Date(0), finishedAt: new Date(0) });
      const r = await w.http.get(`${P()}/boq/compare?from=b_old`).set(as('viewer'));
      expect([r.status, r.body.error.code, r.body.error.message]).toEqual([409, 'not_ready', COMPARE_NO_SNAPSHOT_HE]);
      expect((await w.http.get(`${P()}/boq/compare`).set(w.auth(w.B.uid('admin')))).status).toBe(404);
    });

    it('Excel "תוספות ושינויים" (editor; formulas for Δ and totals); not counted as a BOQ export for "since last export"', async () => {
      expect((await w.http.post(`${P()}/boq/compare/export`).set(as('viewer')).send({})).status).toBe(403);
      const r = await w.http.post(`${P()}/boq/compare/export`).set(as('editor')).send({ to: 'b1' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const body = BoqCompareExportResponseSchema.parse(r.body);
      expect([body.fromBuildId, body.toBuildId]).toEqual(['b0', 'b1']);
      const ws = (await loadXlsx(body.url, w.t.boqStorage.objects)).getWorksheet(COMPARE_SHEET_NAME) as ExcelJS.Worksheet;
      expect(ws.views[0]?.rightToLeft).toBe(true);
      const row = ws.getRow(5);
      expect([row.getCell(1).value, row.getCell(4).value, row.getCell(5).value, row.getCell(6).value]).toEqual(['4.01', 'שונה', 1, 2]);
      expect(row.getCell(7).formula).toBe('N(F5)-N(E5)');
      expect(row.getCell(12).formula).toBe('K5-J5');
      expect(String(row.getCell(13).value)).toMatch(/גרסת גיליון חדשה/);
      expect(ws.getRow(6).getCell(12).formula).toBe('SUM(L5:L5)');
      const rec = w.t.repo.docs.get(fsPaths.boqExport(w.A.orgId, w.A.projectId, body.exportId)) as Doc;
      expect(rec).toMatchObject({ purpose: 'comparison', compare: { fromBuildId: 'b0', toBuildId: 'b1' } });
      const since = BoqComparisonSchema.parse((await w.http.get(`${P()}/boq/compare?base=export&to=b1`).set(as('viewer'))).body);
      expect(since.from.exportId).not.toBe(body.exportId);
    });
  });

  // ------------------------------------------------------------------ integration (web)
  describe('Sprint 8 integration (web)', () => {
    it('default compare = LIVE current lines (today\'s prices / overrides) vs the build before the latest', async () => {
      const c = BoqComparisonSchema.parse((await w.http.get(`${P()}/boq/compare`).set(as('viewer'))).body);
      expect(c).toMatchObject({ base: 'previous', from: { buildId: 'b0' }, to: { buildId: 'b1', live: true } });
      const l = c.items.find((i) => i.lineId === w.A.lines.status);
      // b0: qty 1 × ₪100; now: qty 2 × the library price ₪120
      expect(l).toMatchObject({ kind: 'changed', fromQty: 1, toQty: 2, fromPrice: 100, toPrice: 120, deltaTotal: 140 });
      expect(l?.changes).toEqual(expect.arrayContaining(['qty', 'price']));
      expect(c.items.find((i) => i.lineId === w.A.lines.approved)).toMatchObject({ kind: 'added', toPrice: 50 }); // the override of today
      const stored = BoqComparisonSchema.parse((await w.http.get(`${P()}/boq/compare?to=b1`).set(as('viewer'))).body);
      expect(stored.to.live).toBeUndefined();
    });

    it('GET …/boq/builds: newest first, line count, snapshot flag, last export, latest', async () => {
      const bp = fsPaths.boqBuild(w.A.orgId, w.A.projectId, 'b1');
      w.t.repo.docs.set(bp, { ...(w.t.repo.docs.get(bp) as Doc), stats: { lines: 4, green: 4, yellow: 0, red: 0, sheets: 1, evidence: 1 }, linesRef: storagePaths.boqLinesSnapshot(w.A.orgId, w.A.projectId, 'b1') });
      const r = await w.http.get(`${P()}/boq/builds?limit=20`).set(as('viewer'));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const list = BoqBuildListSchema.parse(r.body);
      const b1 = list.items.find((b) => b.buildId === 'b1');
      expect(b1).toMatchObject({ status: 'succeeded', lineCount: 4, hasSnapshot: true, latest: true });
      expect(b1?.exportedAt).toBeTruthy();
      expect(list.items.find((b) => b.buildId === 'b0')).toMatchObject({ lineCount: null, hasSnapshot: false, exportedAt: null, latest: false });
      const at = list.items.map((b) => b.createdAt ?? '');
      expect([...at].sort().reverse()).toEqual(at);
      expect((await w.http.get(`${P()}/boq/builds?limit=0`).set(as('viewer'))).status).toBe(400);
      expect((await w.http.get(`${P()}/boq/builds`).set(w.auth(w.B.uid('admin')))).status).toBe(404);
    });

    it('price import dry run → review → apply-prices: planned items written, manual ones only when chosen; once; audited', async () => {
      // item 4.01 has a MANUAL price 120; 4.02 an imported-able price; 4.03 manual via bulk (45.5)
      const bad = await w.http.post('/api/v1/library/imports').set(as('editor')).send({ orgId: w.A.orgId, filename: 'p.xlsx', sizeBytes: 10, dryRun: true });
      expect(bad.status).toBe(400); // dryRun needs mode 'prices'
      const c = CreateLibraryImportResponseSchema.parse((await w.http.post('/api/v1/library/imports').set(as('editor')).send({ orgId: w.A.orgId, filename: 'p.xlsx', sizeBytes: 1000, mode: 'prices', dryRun: true })).body);
      expect(c.import.dryRun).toBe(true);
      w.t.boqStorage.putImport(c.storagePath, await xlsxBytes());
      expect((await w.http.post(`/api/v1/library/imports/${c.import.id}/finalize`).set(as('editor')).send({ orgId: w.A.orgId })).status).toBe(202);
      expect((w.t.queue.messages.find((m) => (m.data as Doc).importId === c.import.id)?.data as Doc).dryRun).toBe(true);
      const apply = (body: object, who = as('editor')) => w.http.post(`/api/v1/library/imports/${c.import.id}/apply-prices`).set(who).send({ orgId: w.A.orgId, ...body });
      expect((await apply({})).status).toBe(409); // not finished yet
      const ip = fsPaths.libraryImport(w.A.orgId, c.import.id);
      const report = {
        rows: 4, matched: 4, applied: 0, unchanged: 0, unmatched: 0, conflicts: 2, skippedManual: 2, overwriteManualPrices: false, dryRun: true, unmatchedRows: [],
        planned: [{ itemId: items['4.02'], code: '4.02', amount: 90, current: 80, currentSource: 'manual' }],
        conflictRows: [
          { row: 2, code: '4.01', itemId: items['4.01'], reason: 'manual_price', current: 120, incoming: 130 },
          { row: 4, code: '4.03', itemId: items['4.03'], reason: 'manual_price', current: 45.5, incoming: 60 },
        ],
      };
      w.t.repo.docs.set(ip, { ...(w.t.repo.docs.get(ip) as Doc), status: 'succeeded', stats: { items: 0, created: 0, updated: 0, templates: 0, prices: report } });
      // the GET of a dry run writes no import_prices audit (nothing was written)
      const before = auditsOf(w.t, w.A.orgId).filter((e) => e.action === 'import_prices').length;
      await w.http.get(`/api/v1/library/imports/${c.import.id}?orgId=${w.A.orgId}`).set(as('viewer'));
      expect(auditsOf(w.t, w.A.orgId).filter((e) => e.action === 'import_prices').length).toBe(before);
      expect((await apply({ overwriteItemIds: [items['4.01']] }, as('reviewer'))).status).toBe(403);

      const r = await apply({ overwriteItemIds: [items['4.01']] });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const out = ApplyImportPricesResponseSchema.parse(r.body);
      // 4.02 was planned while not manual… it became manual (bulk earlier) → kept; 4.01 explicitly overwritten; 4.03 kept
      expect(out).toMatchObject({ applied: 1, overwritten: 1, kept: 2, skipped: [{ itemId: items['4.02'], reason: 'manual_kept' }] });
      const listed = (await w.http.get(`/api/v1/library/items?orgId=${w.A.orgId}&q=4.01`).set(as('viewer'))).body.items as Doc[];
      const it01 = ItemLibraryItemSchema.parse(listed.find((i) => i.id === items['4.01']));
      expect(it01.price).toMatchObject({ amount: 130, source: 'import', importId: c.import.id, by: w.A.uid('editor') });
      expect((await apply({})).status).toBe(409); // once
      const sum = auditsOf(w.t, w.A.orgId).filter((e) => e.action === 'import_prices').at(-1);
      expect(sum?.after).toMatchObject({ importId: c.import.id, apply: true, applied: 1, overwritten: 1, kept: 2 });
      // restore the manual 120 for the other tests' arithmetic
      await w.http.patch(`/api/v1/library/items/${items['4.01']}?orgId=${w.A.orgId}`).set(as('editor')).send({ price: 120 });
    });

    it('project sheetCount / sheetLimit; sheet set storageBytes', async () => {
      const p = await w.http.get(P()).set(as('viewer'));
      expect(p.body).toMatchObject({ sheetLimit: 100 });
      expect(p.body.sheetCount).toBeGreaterThanOrEqual(1);
      const list = await w.http.get(`/api/v1/projects?orgId=${w.A.orgId}`).set(as('viewer'));
      expect((list.body.items as Doc[]).every((x) => x.sheetLimit === 100)).toBe(true);
      const set = await w.http.get(`${P()}/sheet-sets/${w.A.delSets.viewer}`).set(as('viewer'));
      expect(set.body.sheetSet).toMatchObject({ sizeBytes: 10, storageBytes: 10 });
    });
  });

  // ------------------------------------------------------------------ deletes
  describe('deletes', () => {
    it('sheet set (editor): sheets / versions / artifacts / source gone, quota released, its share links revoked, audited; busy → 409', async () => {
      const setId = 'c'.repeat(64);
      const s = seedSheet(w.t, w.A.orgId, w.A.projectId, setId, { detections: [det('d_9', 'socket_double', 10, 10, 0.99, 'green')] });
      const vp = fsPaths.version(w.A.orgId, w.A.projectId, s.sheetId, s.versionId);
      w.t.repo.docs.set(vp, { ...(w.t.repo.docs.get(vp) as Doc), titleBlockMm: { x: 700, y: 500, w: 141, h: 94 } });
      const src = storagePaths.projectUpload(w.A.orgId, w.A.projectId, setId, 'pdf');
      w.t.repo.docs.set(fsPaths.sheetSet(w.A.orgId, w.A.projectId, setId), { fileKind: 'pdf', sha256: setId, storagePath: src, status: 'ready', name: 'x.pdf', sizeBytes: 5000, createdAt: new Date(0) });
      w.t.storage.objects.set(src, { data: SAMPLE.pdf, contentType: 'application/pdf' });
      const pp = fsPaths.project(w.A.orgId, w.A.projectId);
      w.t.repo.docs.set(pp, { ...(w.t.repo.docs.get(pp) as Doc), storageBytes: 9000 });
      const corr = await w.http.post(`${P()}/corrections`).set(as('reviewer')).send({ sheetId: s.sheetId, versionId: s.versionId, anchorMm: { x: 10, y: 10 }, kind: 'accept', detectionId: 'd_9' });
      expect(corr.status).toBe(201);
      const link = CreateShareLinkResponseSchema.parse((await w.http.post(`${P()}/share-links`).set(as('editor')).send({ label: 'מחיקה', days: 3 })).body);
      expect(link.link.versionLockBySheet[s.sheetId]).toBe(s.versionId);
      expect((await w.http.delete(`${P()}/sheet-sets/${setId}`).set(as('reviewer'))).status).toBe(403);
      // busy while being processed
      const sp = fsPaths.sheetSet(w.A.orgId, w.A.projectId, setId);
      w.t.repo.docs.set(sp, { ...(w.t.repo.docs.get(sp) as Doc), status: 'splitting', createdAt: new Date() });
      const busy = await w.http.delete(`${P()}/sheet-sets/${setId}`).set(as('editor'));
      expect([busy.status, busy.body.error.code]).toEqual([409, 'conflict']);
      w.t.repo.docs.set(sp, { ...(w.t.repo.docs.get(sp) as Doc), status: 'ready', createdAt: new Date(0) });

      const r = await w.http.delete(`${P()}/sheet-sets/${setId}`).set(as('editor'));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const out = DeleteSheetSetResponseSchema.parse(r.body);
      expect(out).toMatchObject({ sheetSetId: setId, releasedBytes: 5000, storageBytes: 4000, storageQuotaBytes: 2 * 1024 ** 3, revokedShareLinks: 1, deleted: { sheets: 1, versions: 1 } });
      expect(out.deleted.docs).toBeGreaterThanOrEqual(1); // the correction
      expect(out.deleted.objects).toBeGreaterThanOrEqual(3); // source + detections + rooms
      expect(w.t.repo.docs.has(sp)).toBe(false);
      expect([...w.t.repo.docs.keys()].some((k) => k.includes(`/sheets/${s.sheetId}`))).toBe(false);
      expect(w.t.storage.objects.has(src)).toBe(false);
      expect([...w.t.artifacts.objects.keys()].some((k) => k.includes(`/sheets/${s.sheetId}/`))).toBe(false);
      expect((w.t.repo.docs.get(pp) as Doc).storageBytes).toBe(4000);
      expect(((w.t.repo.docs.get(pp) as Doc).boq as Doc).stale).toBe(true);
      expect(w.t.repo.docs.get(fsPaths.shareLink(w.A.orgId, w.A.projectId, link.link.id))).toMatchObject({ revokeReason: 'sheet_set_deleted' });
      expect((await w.http.get(`/api/v1/public/share/${link.token}/meta`)).status).toBe(410);
      const evs = auditsOf(w.t, w.A.orgId);
      expect(evs.find((e) => e.entity === 'sheetSets' && e.action === 'delete')?.after).toMatchObject({ sheets: 1, releasedBytes: 5000, revokedShareLinks: 1 });
      expect(evs.some((e) => e.action === 'revoke_all' && (e.after as Doc).reason === 'sheet_set_deleted')).toBe(true);
      // other sets / the world's sheets are untouched; a second delete → 404
      expect(w.t.repo.docs.has(fsPaths.sheet(w.A.orgId, w.A.projectId, w.A.sheet.sheetId))).toBe(true);
      expect((await w.http.delete(`${P()}/sheet-sets/${setId}`).set(as('editor'))).status).toBe(404);
      expect((await w.http.delete(`${P()}/sheet-sets/${setId}`).set(w.auth(w.B.uid('admin')))).status).toBe(404);
    });

    it('project (admin + MFA, typed name): everything under the project removed, links revoked + token index gone, audited', async () => {
      const created = await w.http.post('/api/v1/projects').set(as('editor')).send({ orgId: w.A.orgId, name: 'פרויקט למחיקה', address: 'x' });
      const pid = created.body.id as string;
      const s = seedSheet(w.t, w.A.orgId, pid, 'd'.repeat(64), { detections: [] });
      const vp = fsPaths.version(w.A.orgId, pid, s.sheetId, s.versionId);
      w.t.repo.docs.set(vp, { ...(w.t.repo.docs.get(vp) as Doc), titleBlockMm: { x: 700, y: 500, w: 141, h: 94 } });
      const src = storagePaths.projectUpload(w.A.orgId, pid, 'd'.repeat(64), 'pdf');
      w.t.repo.docs.set(fsPaths.sheetSet(w.A.orgId, pid, 'd'.repeat(64)), { fileKind: 'pdf', sha256: 'd'.repeat(64), storagePath: src, status: 'ready', sizeBytes: 700, createdAt: new Date(0) });
      w.t.storage.objects.set(src, { data: SAMPLE.pdf, contentType: 'application/pdf' });
      w.t.storage.objects.set(storagePaths.infected(w.A.orgId, pid, 'e'.repeat(64), 'f'.repeat(64)), { data: Buffer.from('x'), contentType: 'application/octet-stream' });
      w.t.boq.seedLine(w.A.orgId, pid, { id: 'ln_del', code: '4.01', qty: 1 });
      const link = CreateShareLinkResponseSchema.parse((await w.http.post(`/api/v1/projects/${pid}/share-links`).set(as('editor')).send({ label: 'x', days: 3 })).body);
      const tokenDocs = () => [...w.t.repo.docs.entries()].filter(([k, d]) => k.startsWith('shareTokens/') && (d as Doc).projectId === pid).length;
      expect(tokenDocs()).toBe(1);

      const del = (who: { authorization: string }, confirmName: unknown) => w.http.delete(`/api/v1/projects/${pid}`).set(who).send({ confirmName });
      expect((await del(as('editor'), 'פרויקט למחיקה')).status).toBe(403);
      const nomfa = await del(w.auth('a_admin_nomfa'), 'פרויקט למחיקה');
      expect([nomfa.status, nomfa.body.error.code]).toEqual([403, 'mfa_required']);
      const wrong = await del(as('admin'), 'פרויקט אחר');
      expect([wrong.status, wrong.body.error.message]).toEqual([400, PROJECT_DELETE_MISMATCH_HE]);
      expect((await w.http.delete(`/api/v1/projects/${pid}`).set(as('admin')).send({})).status).toBe(400);
      expect((await del(w.auth(w.B.uid('admin')), 'פרויקט למחיקה')).status).toBe(404);

      const r = await del(as('admin'), '  פרויקט   למחיקה ');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const out = DeleteProjectResponseSchema.parse(r.body);
      expect(out).toMatchObject({ projectId: pid, releasedBytes: 700, revokedShareLinks: 1 });
      expect(out.deleted.docs).toBeGreaterThanOrEqual(5);
      expect(out.deleted.objects).toBeGreaterThanOrEqual(3);
      const prefix = `orgs/${w.A.orgId}/projects/${pid}`;
      expect([...w.t.repo.docs.keys()].some((k) => k === prefix || k.startsWith(`${prefix}/`))).toBe(false);
      for (const m of [w.t.storage.objects, w.t.boqStorage.objects, w.t.artifacts.objects, w.t.govStorage.objects]) expect([...m.keys()].some((k) => k.startsWith(`${prefix}/`))).toBe(false);
      expect(tokenDocs()).toBe(0);
      expect((await w.http.get(`/api/v1/projects/${pid}`).set(as('admin'))).status).toBe(404);
      expect([404, 410]).toContain((await w.http.get(`/api/v1/public/share/${link.token}/meta`)).status);
      const ev = auditsOf(w.t, w.A.orgId).find((e) => e.entity === 'projects' && e.action === 'delete');
      expect(ev).toMatchObject({ entityId: pid, actorId: w.A.uid('admin') });
      expect(ev?.after).toMatchObject({ name: 'פרויקט למחיקה', releasedBytes: 700, revokedShareLinks: 1 });
      // the other project of the org is untouched
      expect((await w.http.get(P()).set(as('viewer'))).status).toBe(200);
    });
  });
});
