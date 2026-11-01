/**
 * Sprint 6 (API): BOQ line read path (origin / needsInput / quickAction), quick-measure (corrections bound to a line,
 * stale + debounced rebuild, audit, roles), bulk status (batch-status: state machine, Stage 10 re-approval, red, audit
 * with one batchId, history label), evidence targets of text / geometry / stair items, overlay geometry URL, and the
 * idempotent top-up of the default library + template upgrade.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BatchLineStatusResponseSchema,
  BoqLineEvidenceResponseSchema,
  BoqViewSchema,
  DEFAULT_BOQ_TEMPLATE,
  DEFAULT_ITEM_LIBRARY,
  DEFAULT_ITEM_LIBRARY_ADDITIONS,
  fsPaths,
  LineHistoryResponseSchema,
  OverlayManifestSchema,
  QuickMeasureResponseSchema,
  storagePaths,
} from '@kamutan/contracts';
import type { Doc } from '../../src/db/mappers';
import { auditsOf, createWorld, type World } from '../acceptance/support/world';

describe('Sprint 6 e2e (API)', () => {
  let w: World;
  const P = () => `/api/v1/projects/${w.A.projectId}`;
  const as = (r: 'viewer' | 'reviewer' | 'editor' | 'admin') => w.auth(w.A.uid(r));
  const seed = (id: string, extra: Record<string, unknown>) =>
    w.t.boq.seedLine(w.A.orgId, w.A.projectId, { id, code: '7.01', chapter: '06', description: 'תקרת גבס', qty: 0, unit: 'מ"ר', level: 'red', status: 'draft', buildId: 'b1', ...extra } as never);
  const settle = () => {
    const pp = fsPaths.project(w.A.orgId, w.A.projectId);
    const boq = ((w.t.repo.docs.get(pp) as Doc).boq ?? {}) as Doc;
    for (const id of [boq.pendingBuildId, boq.autoBuildId]) {
      if (typeof id !== 'string') continue;
      const bp = fsPaths.boqBuild(w.A.orgId, w.A.projectId, id);
      w.t.repo.docs.set(bp, { ...(w.t.repo.docs.get(bp) as Doc), status: 'succeeded' });
    }
    w.t.repo.docs.set(pp, { ...(w.t.repo.docs.get(pp) as Doc), boq: { latestBuildId: 'b1', builtAt: new Date(), stale: false, pendingBuildId: null, autoBuildId: null } });
  };

  beforeAll(async () => {
    w = await createWorld();
  });
  afterAll(async () => {
    await w.t.app.close();
  });

  it('GET boq exposes origin / needsInput / quickAction (tolerant mapper)', async () => {
    seed('ln_s6_7_01', { origin: 'suggested', needsInput: true, quickAction: { kind: 'measure_area', sheetId: w.A.sheet.sheetId } });
    seed('ln_s6_7_02', { code: '7.02', origin: 'bogus', quickAction: { kind: 'draw', sheetId: 1 } });
    const lineDoc = fsPaths.boqLine(w.A.orgId, w.A.projectId, 'ln_s6_7_03');
    w.t.repo.docs.set(lineDoc, { chapter: '06', code: '7.03', description: 'x', qty: null, unit: 'מ"ר', level: 'red', status: 'draft' });
    const view = BoqViewSchema.parse((await w.http.get(`${P()}/boq?chapter=06`).set(as('viewer'))).body);
    const by = Object.fromEntries(view.items.map((l) => [l.id, l]));
    expect(by.ln_s6_7_01).toMatchObject({ origin: 'suggested', needsInput: true, quickAction: { kind: 'measure_area', sheetId: w.A.sheet.sheetId } });
    expect(by.ln_s6_7_02?.origin).toBeUndefined();
    expect(by.ln_s6_7_02?.quickAction).toBeNull();
    expect(by.ln_s6_7_03).toMatchObject({ qty: 0, needsInput: true });
  });

  describe('POST …/boq/lines/:lineId/quick-measure', () => {
    const url = (id: string) => `${P()}/boq/lines/${id}/quick-measure`;
    const poly = { type: 'polygon', mm: [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 40 }] };

    it('measure_area → measure correction bound to the line, BOQ stale + auto rebuild, audited with lineId', async () => {
      settle();
      const r = await w.http.post(url('ln_s6_7_01')).set(as('reviewer')).send({ kind: 'measure_area', sheetId: w.A.sheet.sheetId, geometry: poly });
      expect(r.status).toBe(201);
      const body = QuickMeasureResponseSchema.parse(r.body);
      expect(body.correction).toMatchObject({ kind: 'measure', unit: 'm2', itemCode: '7.01', lineId: 'ln_s6_7_01', quickAction: 'measure_area', versionId: w.A.sheet.versionId, sheetId: w.A.sheet.sheetId });
      expect(body.correction.anchorMm.x).toBeCloseTo(130 / 3, 5);
      expect(body.line.id).toBe('ln_s6_7_01');
      expect(body.rebuild).toMatchObject({ stale: true, autoRebuild: 'scheduled' });
      const proj = w.t.repo.docs.get(fsPaths.project(w.A.orgId, w.A.projectId)) as Doc;
      expect((proj.boq as Doc).stale).toBe(true);
      expect((proj.boq as Doc).staleReason).toBe('correction');
      const ev = auditsOf(w.t, w.A.orgId).find((e) => e.entity === 'corrections' && e.entityId === body.correction.id);
      expect(ev?.after).toMatchObject({ kind: 'measure', lineId: 'ln_s6_7_01', quickAction: 'measure_area', itemCode: '7.01' });
      // a second edit within the debounce window only pushes the queued build back
      const again = QuickMeasureResponseSchema.parse((await w.http.post(url('ln_s6_7_01')).set(as('editor')).send({ kind: 'measure_length', sheetId: w.A.sheet.sheetId, geometry: { type: 'polyline', mm: poly.mm } })).body);
      expect(again.correction).toMatchObject({ kind: 'measure', unit: 'm', quickAction: 'measure_length' });
      expect(again.rebuild.autoRebuild).toBe('debounced');
      settle();
    });

    it('count → count correction (quantity = clicks); confirm → accept bound to the line', async () => {
      const c = QuickMeasureResponseSchema.parse((await w.http.post(url(w.A.lines.plain)).set(as('reviewer')).send({ kind: 'count', sheetId: w.A.sheet.sheetId, geometry: { type: 'point', mm: poly.mm } })).body);
      expect(c.correction).toMatchObject({ kind: 'count', unit: 'unit', quantity: 3, itemCode: '4.04', lineId: w.A.lines.plain });
      const k = QuickMeasureResponseSchema.parse((await w.http.post(url(w.A.lines.plain)).set(as('reviewer')).send({ kind: 'confirm', sheetId: w.A.sheet.sheetId })).body);
      expect(k.correction).toMatchObject({ kind: 'accept', quantity: 1, geometry: null, lineId: w.A.lines.plain, quickAction: 'confirm', detectionId: null });
      const k2 = QuickMeasureResponseSchema.parse((await w.http.post(url('ln_s6_7_01')).set(as('reviewer')).send({ kind: 'confirm', sheetId: w.A.sheet.sheetId, quantity: 4.5, reason: 'נמדד באתר' })).body);
      expect(k2.correction).toMatchObject({ quantity: 4.5, reason: 'נמדד באתר' });
      // listed with the other corrections and in the line history
      const list = (await w.http.get(`${P()}/corrections?kind=accept`).set(as('viewer'))).body as { items: Array<{ id: string }> };
      expect(list.items.map((i) => i.id)).toContain(k.correction.id);
      const hist = LineHistoryResponseSchema.parse((await w.http.get(`${P()}/boq/lines/${w.A.lines.plain}/history`).set(as('viewer'))).body);
      expect(hist.items.filter((i) => i.action === 'correction').map((i) => i.sourceId)).toEqual(expect.arrayContaining([c.correction.id, k.correction.id]));
      settle();
    });

    it('roles, validation and not-found', async () => {
      const body = { kind: 'measure_area', sheetId: w.A.sheet.sheetId, geometry: poly };
      expect((await w.http.post(url('ln_s6_7_01')).set(as('viewer')).send(body)).status).toBe(403);
      expect((await w.http.post(url('ln_s6_7_01')).send(body)).status).toBe(401);
      expect((await w.http.post(url('ln_s6_7_01')).set(w.auth(w.B.uid('admin'))).send(body)).status).toBe(404);
      expect((await w.http.post(url('ln_nope')).set(as('reviewer')).send(body)).status).toBe(404);
      expect((await w.http.post(url('ln_s6_7_01')).set(as('reviewer')).send({ ...body, sheetId: 'nosuch-p0' })).status).toBe(404);
      expect((await w.http.post(url('ln_s6_7_01')).set(as('reviewer')).send({ ...body, versionId: 'v_missing' })).status).toBe(404);
      expect((await w.http.post(url('ln_s6_7_01')).set(as('reviewer')).send({ ...body, geometry: { type: 'polyline', mm: poly.mm } })).status).toBe(400);
      expect((await w.http.post(url('ln_s6_7_01')).set(as('reviewer')).send({ ...body, geometry: { type: 'polygon', mm: [{ x: 1, y: 1 }, { x: 9000, y: 1 }, { x: 1, y: 9 }] } })).status).toBe(400);
      const needs = await w.http.post(url('ln_s6_7_01')).set(as('reviewer')).send({ kind: 'confirm', sheetId: w.A.sheet.sheetId });
      expect([needs.status, needs.body.error.issues?.[0]?.path]).toEqual([400, 'quantity']);
      settle();
    });
  });

  describe('POST …/boq/lines/batch-status', () => {
    const url = () => `${P()}/boq/lines/batch-status`;
    const L = (n: string) => `ln_bs_${n}`;
    beforeAll(() => {
      const mk = (n: string, extra: Record<string, unknown>) => w.t.boq.seedLine(w.A.orgId, w.A.projectId, { id: L(n), code: `4.${n}`, qty: 2, level: 'green', status: 'draft', buildId: 'b1', ...extra } as never);
      mk('50', {});
      mk('51', { status: 'reviewed', reviewedBy: w.A.uid('reviewer') });
      mk('52', { level: 'red' });
      mk('53', { status: 'approved', approvedBy: w.A.uid('reviewer'), approvedQty: 2 });
      // Stage 10: approved, then the rebuild changed the qty (legacy: worker kept the status) → needs re-approval
      mk('54', { status: 'approved', approvedBy: w.A.uid('reviewer'), approvedQty: 2, qty: 3, reasons: ['הכמות השתנתה מאז האישור (2 → 3)'] });
      mk('55', { status: 'reviewed', level: 'red' });
    });

    it('approve: forward only via the single-PATCH rules; red skipped; re-approval; one audit event per line with one batchId', async () => {
      const ids = [L('50'), L('51'), L('52'), L('53'), L('54'), 'ln_missing'];
      const r = await w.http.post(url()).set(as('reviewer')).send({ lineIds: ids, to: 'approved' });
      expect(r.status).toBe(200);
      const b = BatchLineStatusResponseSchema.parse(r.body);
      expect(b.updated).toEqual([
        { lineId: L('50'), from: 'draft', to: 'approved' },
        { lineId: L('51'), from: 'reviewed', to: 'approved' },
        { lineId: L('54'), from: 'reviewed', to: 'approved' },
      ]);
      expect(b.skipped).toEqual([
        { lineId: L('52'), reason: 'red' },
        { lineId: L('53'), reason: 'already' },
        { lineId: 'ln_missing', reason: 'not_found' },
      ]);
      const doc = (n: string) => w.t.repo.docs.get(fsPaths.boqLine(w.A.orgId, w.A.projectId, L(n))) as Doc;
      expect(doc('50')).toMatchObject({ status: 'approved', reviewedBy: w.A.uid('reviewer'), approvedBy: w.A.uid('reviewer'), approvedQty: 2 });
      expect(doc('54')).toMatchObject({ status: 'approved', approvedQty: 3, reasons: [] });
      const evs = auditsOf(w.t, w.A.orgId).filter((e) => e.entity === 'boqLines' && (e.after as Doc | null)?.batchId === b.batchId);
      expect(evs.map((e) => e.entityId).sort()).toEqual([L('50'), L('51'), L('54')]);
      expect(evs.find((e) => e.entityId === L('50'))?.after).toMatchObject({ from: 'draft', to: 'approved', projectId: w.A.projectId });
      const hist = LineHistoryResponseSchema.parse((await w.http.get(`${P()}/boq/lines/${L('50')}/history`).set(as('viewer'))).body);
      expect(hist.items.find((i) => i.action === 'status')?.summary).toBe('אושר (פעולה קבוצתית) · טיוטה → אושר');
      // the same call again changes nothing
      const again = BatchLineStatusResponseSchema.parse((await w.http.post(url()).set(as('reviewer')).send({ lineIds: ids, to: 'approved' })).body);
      expect(again.updated).toEqual([]);
      expect(again.batchId).not.toBe(b.batchId);
    });

    it('includeRed; to reviewed never un-approves; roles and validation', async () => {
      const r = BatchLineStatusResponseSchema.parse((await w.http.post(url()).set(as('editor')).send({ lineIds: [L('52'), L('53')], to: 'reviewed', includeRed: true })).body);
      expect(r.updated).toEqual([{ lineId: L('52'), from: 'draft', to: 'reviewed' }]);
      expect(r.skipped).toEqual([{ lineId: L('53'), reason: 'already' }]);
      const red = BatchLineStatusResponseSchema.parse((await w.http.post(url()).set(as('admin')).send({ lineIds: [L('55')], to: 'approved', includeRed: true })).body);
      expect(red.updated).toEqual([{ lineId: L('55'), from: 'reviewed', to: 'approved' }]);
      expect((await w.http.post(url()).set(as('viewer')).send({ lineIds: [L('50')], to: 'approved' })).status).toBe(403);
      expect((await w.http.post(url()).set(w.auth(w.B.uid('admin'))).send({ lineIds: [L('50')], to: 'approved' })).status).toBe(404);
      expect((await w.http.post(url()).set(as('reviewer')).send({ lineIds: [], to: 'approved' })).status).toBe(400);
      expect((await w.http.post(url()).set(as('reviewer')).send({ lineIds: [L('50')], to: 'draft' })).status).toBe(400);
      expect((await w.http.post(url()).set(as('reviewer')).send({ lineIds: Array.from({ length: 501 }, (_, i) => `ln_${i}`), to: 'approved' })).status).toBe(400);
    });

    it('chunks: 250 lines in one call (3 transactions) all move', async () => {
      const ids = Array.from({ length: 250 }, (_, i) => `ln_bulk_${i}`);
      for (const id of ids) w.t.boq.seedLine(w.A.orgId, w.A.projectId, { id, code: '4.99', qty: 1, level: 'yellow', status: 'draft', buildId: 'b1' } as never);
      const r = BatchLineStatusResponseSchema.parse((await w.http.post(url()).set(as('reviewer')).send({ lineIds: ids, to: 'reviewed' })).body);
      expect(r.updated).toHaveLength(250);
      expect(r.updated[249]?.lineId).toBe('ln_bulk_249');
    });
  });

  it('evidence targets of text / geometry / stair items (Sprint 6 kinds)', async () => {
    const { sheetId, versionId } = w.A.sheet;
    w.t.boqStorage.putEvidence(storagePaths.boqEvidence(w.A.orgId, w.A.projectId, 'b6'), {
      schema: 'kamutan.boq-evidence/1',
      lines: {
        ln_s6_ev: [
          { sheetId, versionId, detectionId: 't_3', linkGroupId: null, floor: '0', kind: 'text', bboxMm: { x: 5, y: 6, w: 7, h: 2 } },
          { sheetId, versionId, detectionId: 'hr_1', linkGroupId: null, floor: '0', kind: 'geometry', quantity: 4.2, geometryMm: { type: 'polygon', mm: [{ x: 10, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 25 }] } },
          { sheetId, versionId, detectionId: 'st_1', linkGroupId: null, floor: '-1', kind: 'stair', quantity: 11, stair: { treads: 11 }, geometryMm: { type: 'polyline', mm: [{ x: 1, y: 1 }, { x: 4, y: 9 }] } },
        ],
      },
    });
    seed('ln_s6_ev', { evidenceRef: storagePaths.boqEvidence(w.A.orgId, w.A.projectId, 'b6'), origin: 'geometry' });
    const ev = BoqLineEvidenceResponseSchema.parse((await w.http.get(`${P()}/boq/lines/ln_s6_ev/evidence`).set(as('viewer'))).body);
    expect(ev.items.map((i) => i.target)).toEqual([
      { kind: 'text', bboxMm: { x: 5, y: 6, w: 7, h: 2 } },
      { kind: 'geometry', bboxMm: { x: 10, y: 20, w: 20, h: 5 } },
      { kind: 'stair', bboxMm: { x: 1, y: 1, w: 3, h: 8 } },
    ]);
    expect(ev.bySheet.reduce((a, g) => a + g.count, 0)).toBeCloseTo(16.2, 6);
  });

  it('overlay manifest signs geometry.json.gz when the version has it (text_items never)', async () => {
    const { sheetId, versionId } = w.A.sheet;
    const vp = fsPaths.version(w.A.orgId, w.A.projectId, sheetId, versionId);
    const v = w.t.repo.docs.get(vp) as Doc;
    w.t.repo.docs.set(vp, { ...v, artifacts: { ...(v.artifacts as Doc), geometry: storagePaths.geometry(w.A.orgId, w.A.projectId, sheetId, versionId), textItems: storagePaths.textItems(w.A.orgId, w.A.projectId, sheetId, versionId) } });
    const m = OverlayManifestSchema.parse((await w.http.get(`${P()}/sheets/${sheetId}/versions/${versionId}/overlay`).set(as('viewer'))).body);
    expect(m.geometry?.url).toContain('geometry.json.gz');
    expect(JSON.stringify(m)).not.toContain('text_items');
  });

  describe('default library v2 + template v3 seeding', () => {
    const lib = (orgId: string) => [...w.t.repo.docs.entries()].filter(([k]) => k.startsWith(`${fsPaths.itemLibrary(orgId)}/`));

    it('a new org gets every default item and template v3', () => {
      const items = lib(w.B.orgId).filter(([, d]) => d.source === 'default');
      expect(items.length).toBe(DEFAULT_ITEM_LIBRARY.length);
      expect((w.t.repo.docs.get(fsPaths.boqTemplate(w.B.orgId, 'tpl_default')) as Doc).defaultsVersion).toBe(DEFAULT_BOQ_TEMPLATE.defaultsVersion);
    });

    it('an org with the v1 default library is topped up idempotently; codes it already has are kept; v2 template upgraded unless edited', async () => {
      const orgId = w.A.orgId;
      for (const it of DEFAULT_ITEM_LIBRARY_ADDITIONS) w.t.repo.docs.delete(fsPaths.libraryItem(orgId, it.id));
      w.t.repo.docs.set(fsPaths.libraryItem(orgId, 'it_7-01_imported'), { code: '7.01', chapter: '06', chapterTitle: 'גבס', description: 'תקרה מיובאת', unit: 'מ"ר', tags: [], source: 'import', active: true });
      const tp = fsPaths.boqTemplate(orgId, 'tpl_default');
      w.t.repo.docs.set(tp, { ...(w.t.repo.docs.get(tp) as Doc), defaultsVersion: 2, chapters: (w.t.repo.docs.get(tp) as Doc).chapters, updatedBy: null });
      expect((await w.http.get(`/api/v1/boq-templates?orgId=${orgId}`).set(as('viewer'))).status).toBe(200);
      const codes = lib(orgId).map(([, d]) => d.code);
      for (const it of DEFAULT_ITEM_LIBRARY_ADDITIONS) expect(codes.filter((c) => c === it.code).length, it.code).toBe(1);
      expect(lib(orgId).find(([, d]) => d.code === '7.01')?.[1].source).toBe('import');
      expect((w.t.repo.docs.get(tp) as Doc).defaultsVersion).toBe(3);
      const n = lib(orgId).length;
      await w.t.boq.seedDefaults(orgId);
      expect(lib(orgId).length).toBe(n);
      // an edited v2 template is never replaced
      w.t.repo.docs.set(tp, { ...(w.t.repo.docs.get(tp) as Doc), defaultsVersion: 2, updatedBy: w.A.uid('admin'), name: 'שלי' });
      await w.t.boq.seedDefaults(orgId);
      expect(w.t.repo.docs.get(tp)).toMatchObject({ defaultsVersion: 2, name: 'שלי' });
    });

    it('an org whose library has no default item (import-only) gets nothing', async () => {
      const orgId = w.B.orgId;
      for (const [k, d] of lib(orgId)) if (d.source === 'default') w.t.repo.docs.delete(k);
      const before = lib(orgId).length;
      expect(before).toBeGreaterThan(0);
      await w.t.boq.seedDefaults(orgId);
      expect(lib(orgId).length).toBe(before);
    });
  });
});
