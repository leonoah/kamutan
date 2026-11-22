/**
 * Sprint 15 (API): "סעיפים שלא זוהו" — GET …/boq/missing-items (library items the pipeline did not find: no line or a 0
 * line) and POST …/boq/exclusions ("לא רלוונטי בפרויקט הזה": editor+, idempotent, audited, stored apart from boqLines so
 * a rebuild keeps it; the BOQ view / preview / Excel / share leave the line out while it has no quantity; restore).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiErrorSchema, BoqDocumentModelSchema, BoqViewSchema, exclusionIdFor, fsPaths, MissingItemsViewSchema, SetBoqExclusionResponseSchema } from '@kamutan/contracts';
import type { Doc } from '../../src/db/mappers';
import { auditsOf, createWorld, type World } from '../acceptance/support/world';

describe('Sprint 15 e2e (API)', () => {
  let w: World;
  const P = () => `/api/v1/projects/${w.A.projectId}`;
  const as = (r: 'viewer' | 'reviewer' | 'editor' | 'admin') => w.auth(w.A.uid(r));
  const missing = async (q = '', who: 'viewer' | 'editor' = 'viewer') => {
    const r = await w.http.get(`${P()}/boq/missing-items${q}`).set(as(who));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return MissingItemsViewSchema.parse(r.body);
  };
  const exclude = (code: string, excluded: boolean, who: 'viewer' | 'reviewer' | 'editor' | 'admin' = 'editor', reason?: string) =>
    w.http.post(`${P()}/boq/exclusions`).set(as(who)).send({ code, excluded, ...(reason ? { reason } : {}) });
  const viewCodes = async () => BoqViewSchema.parse((await w.http.get(`${P()}/boq?limit=500`).set(as('viewer'))).body).items.map((l) => l.code);
  const exDoc = (code: string) => w.t.repo.docs.get(fsPaths.boqExclusion(w.A.orgId, w.A.projectId, exclusionIdFor(code))) as Doc | undefined;
  const audits = (action: string) => auditsOf(w.t, w.A.orgId).filter((a) => a.entity === 'boqExclusions' && a.action === action);

  beforeAll(async () => {
    w = await createWorld();
    // library items: 91.01 (count) and 91.02 (m²) have no line; 91.03 has a 0 line ("להשלמה ידנית"); 91.04 has a counted line
    for (const [code, unit] of [['91.01', "יח'"], ['91.02', 'מ"ר'], ['91.03', "יח'"], ['91.04', "יח'"]] as const) {
      const r = await w.http.post('/api/v1/library/items').set(as('admin')).send({ orgId: w.A.orgId, code, chapter: '91', description: `סעיף ספרייה ${code}`, unit });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    w.t.boq.seedLine(w.A.orgId, w.A.projectId, { id: 'ln_s15_zero', chapter: '91', code: '91.03', description: 'להשלמה', unit: "יח'", qty: 0, needsInput: true, level: 'red', status: 'draft', buildId: 'b1' } as never);
    w.t.boq.seedLine(w.A.orgId, w.A.projectId, { id: 'ln_s15_counted', chapter: '91', code: '91.04', description: 'נספר', unit: "יח'", qty: 3, level: 'green', status: 'draft', buildId: 'b1' } as never);
  });
  afterAll(async () => {
    await w.t.app.close();
  });

  describe('GET …/boq/missing-items', () => {
    it('lists items with no line or a 0 line, sorted by chapter then code; counted items are not missing', async () => {
      const v = await missing();
      expect(v).toMatchObject({ built: true, filter: 'all' });
      const mine = v.items.filter((i) => i.chapter === '91');
      expect(mine.map((i) => [i.code, i.origin, i.lineId, i.markKind, i.state])).toEqual([
        ['91.01', 'no_line', null, 'count', 'open'],
        ['91.02', 'no_line', null, 'measure_area', 'open'],
        ['91.03', 'zero_line', 'ln_s15_zero', 'count', 'open'],
      ]);
      expect(v.items.map((i) => i.code)).not.toContain('4.01'); // has a quantity
      expect(v.items.map((i) => i.code)).not.toContain('91.04');
      expect(v.counts).toEqual({ all: v.items.length, inProject: v.items.length, notRelevant: 0 });
      const keys = v.items.map((i) => `${i.chapter}/${i.code}`);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('400 on an unknown filter; outsider 404; anonymous 401; a project without a build → built:false, empty', async () => {
      expect((await w.http.get(`${P()}/boq/missing-items?filter=nope`).set(as('viewer'))).status).toBe(400);
      expect((await w.http.get(`${P()}/boq/missing-items`).set(w.auth('outsider'))).status).toBe(404);
      expect((await w.http.get(`${P()}/boq/missing-items`)).status).toBe(401);
      const created = await w.http.post('/api/v1/projects').set(as('editor')).send({ orgId: w.A.orgId, name: 'ללא חישוב' });
      const fresh = MissingItemsViewSchema.parse((await w.http.get(`/api/v1/projects/${created.body.id}/boq/missing-items`).set(as('viewer'))).body);
      expect(fresh).toEqual({ built: false, filter: 'all', counts: { all: 0, inProject: 0, notRelevant: 0 }, items: [] });
    });
  });

  describe('POST …/boq/exclusions', () => {
    it('roles: viewer / reviewer 403, outsider 404, unknown code 404, restore of a never-excluded item 404, bad body 400', async () => {
      expect((await exclude('91.03', true, 'viewer')).status).toBe(403);
      expect((await exclude('91.03', true, 'reviewer')).status).toBe(403);
      expect((await w.http.post(`${P()}/boq/exclusions`).set(w.auth('outsider')).send({ code: '91.03', excluded: true })).status).toBe(404);
      expect((await exclude('99.99', true)).status).toBe(404);
      expect((await exclude('91.03', false)).status).toBe(404);
      expect((await w.http.post(`${P()}/boq/exclusions`).set(as('editor')).send({ code: '91.03' })).status).toBe(400);
      expect((await w.http.post(`${P()}/boq/exclusions`).set(as('editor')).send({ code: 'bad code', excluded: true })).status).toBe(400);
      expect(ApiErrorSchema.safeParse((await exclude('99.99', true)).body).success).toBe(true);
      expect(exDoc('91.03')).toBeUndefined();
    });

    it('editor excludes a 0 line: stored per project with who / when, audited without the reason; idempotent', async () => {
      const before = audits('exclude').length;
      const r = await exclude('91.03', true, 'editor', 'אין מזגן בפרויקט');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const body = SetBoqExclusionResponseSchema.parse(r.body);
      expect(body.changed).toBe(true);
      expect(body.exclusion).toMatchObject({ id: exclusionIdFor('91.03'), code: '91.03', active: true, excludedBy: w.A.uid('editor'), reason: 'אין מזגן בפרויקט', restoredBy: null, unit: "יח'", chapter: '91' });
      expect(exDoc('91.03')).toMatchObject({ code: '91.03', active: true, excludedBy: w.A.uid('editor') });
      const ev = audits('exclude');
      expect(ev).toHaveLength(before + 1);
      expect(ev.at(-1)).toMatchObject({ actorId: w.A.uid('editor'), entityId: exclusionIdFor('91.03'), after: { code: '91.03', unit: "יח'" } });
      expect(JSON.stringify(ev.at(-1)?.after)).not.toContain('אין מזגן');
      const again = SetBoqExclusionResponseSchema.parse((await exclude('91.03', true, 'admin')).body);
      expect(again.changed).toBe(false);
      expect(again.exclusion.excludedBy).toBe(w.A.uid('editor')); // the first decision stays
      expect(audits('exclude')).toHaveLength(before + 1);
    });

    it('the list marks it not_relevant (filters + counts); the BOQ view, the preview and the share gate leave the line out', async () => {
      const all = await missing();
      expect(all.items.find((i) => i.code === '91.03')).toMatchObject({ state: 'not_relevant', exclusion: { excludedBy: w.A.uid('editor') } });
      expect(all.counts.notRelevant).toBe(1);
      expect(all.counts.inProject).toBe(all.counts.all - 1);
      expect((await missing('?filter=not_relevant')).items.map((i) => i.code)).toEqual(['91.03']);
      expect((await missing('?filter=in_project')).items.map((i) => i.code)).not.toContain('91.03');
      expect(await viewCodes()).not.toContain('91.03');
      expect(await viewCodes()).toContain('91.04');
      const doc = BoqDocumentModelSchema.parse((await w.http.get(`${P()}/boq/document`).set(as('viewer'))).body);
      expect(doc.chapters.flatMap((c) => c.rows).some((x) => x.lineId === 'ln_s15_zero')).toBe(false);
      const view = BoqViewSchema.parse((await w.http.get(`${P()}/boq?limit=500`).set(as('viewer'))).body);
      expect(view.summary.counts.lines).toBe(view.items.length);
    });

    it('survives a rebuild: the worker rewrites the lines (new ids, same code) and the decision still applies', async () => {
      w.t.repo.docs.delete(fsPaths.boqLine(w.A.orgId, w.A.projectId, 'ln_s15_zero'));
      w.t.boq.seedLine(w.A.orgId, w.A.projectId, { id: 'ln_s15_zero_b2', chapter: '91', code: '91.03', description: 'להשלמה', unit: "יח'", qty: 0, needsInput: true, level: 'red', status: 'draft', buildId: 'b2' } as never);
      expect(await viewCodes()).not.toContain('91.03');
      expect((await missing()).items.find((i) => i.code === '91.03')).toMatchObject({ state: 'not_relevant', lineId: 'ln_s15_zero_b2' });
    });

    it('Excel export and the export gate: an excluded red 0 line neither blocks nor appears; restoring it blocks again', async () => {
      const ok = await w.http.post(`${P()}/boq/export`).set(as('editor')).send({});
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      const doc = BoqDocumentModelSchema.parse((await w.http.get(`${P()}/boq/document`).set(as('viewer'))).body);
      expect(doc.exportBlocked).toBe(false);
      expect(doc.chapters.flatMap((c) => c.rows).some((x) => x.code === '91.03')).toBe(false);
    });

    it('a quantity > 0 (e.g. a manual count made later) shows the line again; the item leaves the missing list', async () => {
      w.t.boq.seedLine(w.A.orgId, w.A.projectId, { id: 'ln_s15_zero_b2', chapter: '91', code: '91.03', description: 'נספר ידנית', unit: "יח'", qty: 2, level: 'green', status: 'draft', buildId: 'b3' } as never);
      expect(await viewCodes()).toContain('91.03');
      expect((await missing()).items.map((i) => i.code)).not.toContain('91.03');
      w.t.boq.seedLine(w.A.orgId, w.A.projectId, { id: 'ln_s15_zero_b2', chapter: '91', code: '91.03', description: 'להשלמה', unit: "יח'", qty: 0, needsInput: true, level: 'red', status: 'draft', buildId: 'b4' } as never);
      expect(await viewCodes()).not.toContain('91.03'); // back to 0 → hidden by the stored decision again
    });

    it('restore (undo): the line is back, the doc is kept as history (who restored, when), audited once', async () => {
      const r = SetBoqExclusionResponseSchema.parse((await exclude('91.03', false, 'admin')).body);
      expect(r.changed).toBe(true);
      expect(r.exclusion).toMatchObject({ active: false, excludedBy: w.A.uid('editor'), restoredBy: w.A.uid('admin') });
      expect(r.exclusion.restoredAt).toBeTruthy();
      expect(exDoc('91.03')).toMatchObject({ active: false, restoredBy: w.A.uid('admin') });
      expect(audits('restore')).toHaveLength(1);
      expect(audits('restore')[0]).toMatchObject({ actorId: w.A.uid('admin'), after: { code: '91.03' } });
      expect(await viewCodes()).toContain('91.03');
      expect((await w.http.post(`${P()}/boq/export`).set(as('editor')).send({})).body.error.code).toBe('export_blocked'); // the red line counts again
      expect((await missing()).items.find((i) => i.code === '91.03')).toMatchObject({ state: 'open', exclusion: null });
      expect(SetBoqExclusionResponseSchema.parse((await exclude('91.03', false)).body).changed).toBe(false);
      expect(audits('restore')).toHaveLength(1);
      // exclude again after a restore keeps working (new who / when, restore stamps cleared)
      const again = SetBoqExclusionResponseSchema.parse((await exclude('91.03', true)).body);
      expect(again).toMatchObject({ changed: true, exclusion: { active: true, restoredBy: null } });
    });

    it('a library item without any line can be excluded too (no_line row → not_relevant) and is tenant-scoped', async () => {
      expect((await exclude('91.01', true)).status).toBe(200);
      expect((await missing()).items.find((i) => i.code === '91.01')).toMatchObject({ state: 'not_relevant', origin: 'no_line' });
      // org B's project does not see A's decision
      const b = MissingItemsViewSchema.parse((await w.http.get(`/api/v1/projects/${w.B.projectId}/boq/missing-items`).set(w.auth(w.B.uid('viewer')))).body);
      expect(b.items.some((i) => i.state === 'not_relevant')).toBe(false);
      expect((await w.http.get(`/api/v1/projects/${w.B.projectId}/boq/missing-items`).set(as('viewer'))).status).toBe(404);
    });

    it('the audit trail is readable in Hebrew (admin audit page summary)', async () => {
      const r = await w.http.get(`/api/v1/orgs/${w.A.orgId}/audit?entity=boqExclusions&limit=50`).set(as('admin'));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const items = r.body.items as Array<{ summary?: string; entityLabel?: string }>;
      expect(items.length).toBeGreaterThan(2);
      expect(items.some((i) => i.summary === 'סעיף 91.03 · סומן כלא רלוונטי בפרויקט הזה')).toBe(true);
      expect(items.some((i) => i.summary === 'סעיף 91.03 · הוחזר לכתב הכמויות')).toBe(true);
      expect(items[0]?.entityLabel).toBe('סעיף שלא זוהה');
    });
  });
});
