import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  applyRebuild,
  BoqBuildJobSchema,
  BoqLineEvidenceResponseSchema,
  BoqSheetEvidenceResponseSchema,
  BoqViewSchema,
  ExportBoqResponseSchema,
  fsPaths,
  JobSchema,
  PatchBoqLineResponseSchema,
  RequestBoqBuildResponseSchema,
  storagePaths,
} from '@kamutan/contracts';
import type { Doc } from '../../src/db/mappers';
import { toJob } from '../../src/db/mappers';
import { MAIN_SHEET } from '../../src/boq/excel';
import { createTestApp, type TestApp } from '../support/app';
import { testConfig } from '../support/helpers';
import { noahLines } from '../fixtures/noah-boq';

describe('BOQ e2e — build, lines, review PATCH, evidence, export (fake auth, in-memory everything)', () => {
  let t: TestApp;
  let http: ReturnType<typeof request>;
  const tok: Record<string, string> = {};
  let orgId: string;
  let otherOrg: string;
  let projectId: string;
  let otherProject: string;
  const auth = (who: string) => ({ authorization: `Bearer ${tok[who]}` });
  const base = (p = projectId) => `/api/v1/projects/${p}/boq`;
  const audits = (o: string) =>
    [...t.repo.docs.entries()]
      .filter(([k]) => k.startsWith(`orgs/${o}/auditLog/`))
      .map(([, v]) => v)
      .sort((a, b) => (a.at as Date).getTime() - (b.at as Date).getTime());
  const projectDoc = (o = orgId, p = projectId) => t.repo.docs.get(fsPaths.project(o, p)) as Doc;
  const seedLines = (o = orgId, p = projectId) => {
    for (const l of noahLines()) t.boq.seedLine(o, p, l);
  };
  const setBlock = (block: boolean) => {
    const d = t.repo.docs.get(fsPaths.org(orgId)) as Doc;
    t.repo.docs.set(fsPaths.org(orgId), { ...d, settings: { ...(d.settings as Doc), blockExportOnRed: block } });
  };

  beforeAll(async () => {
    t = await createTestApp(testConfig({ THROTTLE_LIMIT: '1000', UPLOAD_THROTTLE_LIMIT: '100', EXPORT_THROTTLE_LIMIT: '8' }));
    http = request(t.app.getHttpServer());
    for (const who of ['admin', 'editor', 'reviewer', 'viewer', 'outsider', 'editor2']) tok[who] = t.auth.issue(who);
    orgId = t.repo.seedOrg('Org', { admin: 'admin', editor: 'editor', reviewer: 'reviewer', viewer: 'viewer', editor2: 'editor' }).id;
    otherOrg = t.repo.seedOrg('Other', { outsider: 'admin' }).id;
    projectId = (await t.repo.createProject(orgId, { name: 'בית משפחת נח' }, 'editor')).id;
    otherProject = (await t.repo.createProject(otherOrg, { name: 'Q' }, 'outsider')).id;
    seedLines();
    seedLines(otherOrg, otherProject);
  });
  afterAll(async () => {
    await t.app.close();
  });

  // ---------------------------------------------------------------- build
  describe('POST /boq/build', () => {
    it('viewer / reviewer → 403, outsider → 404, unauthenticated → 401', async () => {
      for (const who of ['viewer', 'reviewer']) expect((await http.post(`${base()}/build`).set(auth(who))).status).toBe(403);
      const r = await http.post(`${base()}/build`).set(auth('outsider'));
      expect(r.status).toBe(404);
      expect(ApiErrorSchema.parse(r.body).error.code).toBe('not_found');
      expect((await http.post(`${base(otherProject)}/build`).set(auth('editor'))).status).toBe(404);
      expect((await http.post(`${base()}/build`)).status).toBe(401);
    });

    it('editor → 202: build doc + job + project.boq.pendingBuildId + boq.build message + audit; dedupe while running', async () => {
      const before = t.queue.messages.length;
      const r = await http.post(`${base()}/build`).set(auth('editor'));
      expect(r.status).toBe(202);
      const body = RequestBoqBuildResponseSchema.parse(r.body);
      expect(body).toMatchObject({ deduplicated: false, build: { status: 'queued', requestedBy: 'editor' } });
      const msg = t.queue.messages.at(-1);
      expect(t.queue.messages.length).toBe(before + 1);
      expect(msg?.attributes).toMatchObject({ type: 'boq.build', orgId, jobId: body.jobId, schemaVersion: '1' });
      expect(BoqBuildJobSchema.parse(msg?.data)).toMatchObject({ orgId, projectId, buildId: body.build.id, jobId: body.jobId });
      const job = toJob(body.jobId as string, t.repo.docs.get(fsPaths.job(body.jobId as string)) as Doc);
      expect(JobSchema.parse(job)).toMatchObject({ type: 'boq.build', orgId, projectId, buildId: body.build.id, status: 'queued' });
      expect((projectDoc().boq as Doc).pendingBuildId).toBe(body.build.id);
      expect(audits(orgId).at(-1)).toMatchObject({ entity: 'boqBuilds', action: 'request', entityId: body.build.id, actorId: 'editor' });
      // the org's defaults were seeded for the worker
      expect(t.repo.docs.has(fsPaths.boqRule(orgId, 'r_light_two_way'))).toBe(true);
      expect(t.repo.docs.has(fsPaths.boqTemplate(orgId, 'tpl_default'))).toBe(true);

      const again = RequestBoqBuildResponseSchema.parse((await http.post(`${base()}/build`).set(auth('editor2'))).body);
      expect(again).toMatchObject({ deduplicated: true, jobId: body.jobId, build: { id: body.build.id } });
      expect(t.queue.messages.length).toBe(before + 1);

      // worker finishes → a new request creates a new build
      const bPath = fsPaths.boqBuild(orgId, projectId, body.build.id);
      t.repo.docs.set(bPath, { ...(t.repo.docs.get(bPath) as Doc), status: 'succeeded', finishedAt: new Date() });
      t.repo.docs.set(fsPaths.project(orgId, projectId), { ...projectDoc(), boq: { latestBuildId: body.build.id, builtAt: new Date(), stale: false, pendingBuildId: null } });
      const third = RequestBoqBuildResponseSchema.parse((await http.post(`${base()}/build`).set(auth('editor'))).body);
      expect(third.deduplicated).toBe(false);
      expect(third.build.id).not.toBe(body.build.id);
      t.repo.docs.set(fsPaths.boqBuild(orgId, projectId, third.build.id), { ...(t.repo.docs.get(fsPaths.boqBuild(orgId, projectId, third.build.id)) as Doc), status: 'succeeded' });
    });

    it('a build stuck for > 30 min no longer blocks', async () => {
      const r1 = RequestBoqBuildResponseSchema.parse((await http.post(`${base()}/build`).set(auth('editor'))).body);
      const p = fsPaths.boqBuild(orgId, projectId, r1.build.id);
      t.repo.docs.set(p, { ...(t.repo.docs.get(p) as Doc), status: 'running', createdAt: new Date(Date.now() - 31 * 60_000) });
      const r2 = RequestBoqBuildResponseSchema.parse((await http.post(`${base()}/build`).set(auth('editor'))).body);
      expect(r2.deduplicated).toBe(false);
      t.repo.docs.set(fsPaths.boqBuild(orgId, projectId, r2.build.id), { ...(t.repo.docs.get(fsPaths.boqBuild(orgId, projectId, r2.build.id)) as Doc), status: 'failed' });
    });

    it('publish failure → 503, build + job failed, pendingBuildId cleared', async () => {
      const orig = t.queue.publish.bind(t.queue);
      t.queue.publish = async () => {
        throw new Error('pubsub down');
      };
      try {
        const r = await http.post(`${base()}/build`).set(auth('editor'));
        expect(r.status).toBe(503);
      } finally {
        t.queue.publish = orig;
      }
      const boq = projectDoc().boq as Doc;
      expect(boq.pendingBuildId).toBeNull();
      const failed = [...t.repo.docs.entries()].filter(([k, v]) => k.startsWith(`${fsPaths.project(orgId, projectId)}/boqBuilds/`) && v.status === 'failed' && (v.error as Doc | null)?.code === 'publish_failed');
      expect(failed.length).toBe(1);
      const job = t.repo.docs.get(fsPaths.job(failed[0]?.[1].jobId as string)) as Doc;
      expect(job.status).toBe('failed');
    });
  });

  // ---------------------------------------------------------------- GET
  describe('GET /boq', () => {
    it('lines in chapter / natural code order, counts, floors, summary; contract-shaped', async () => {
      const r = await http.get(base()).set(auth('viewer'));
      expect(r.status).toBe(200);
      const v = BoqViewSchema.parse(r.body);
      const codes = v.items.map((l) => l.code);
      expect(codes.slice(0, 3)).toEqual(['4.00', '4.01', '4.02']);
      expect(codes.indexOf('4.09')).toBeLessThan(codes.indexOf('4.10'));
      expect(codes.at(-1)).toBe('9.01');
      expect(v.items.find((l) => l.code === '4.10')?.byFloor).toEqual({ 'קומת קרקע': 1, "קומה א'": 1 });
      expect(v.summary.counts).toMatchObject({ lines: 29, red: 1, yellow: 13, green: 15, reviewed: 1, approved: 1 });
      expect(v.summary.floors).toEqual(['מרתף', 'קומת קרקע', "קומה א'"]);
      expect(v.summary.blockExportOnRed).toBe(true);
      expect(v.summary.build).not.toBeNull();
    });

    it('paging + filters', async () => {
      const p1 = BoqViewSchema.parse((await http.get(`${base()}?limit=10`).set(auth('viewer'))).body);
      expect(p1.items).toHaveLength(10);
      const p2 = BoqViewSchema.parse((await http.get(`${base()}?limit=10&cursor=${p1.nextCursor}`).set(auth('viewer'))).body);
      const p3 = BoqViewSchema.parse((await http.get(`${base()}?limit=10&cursor=${p2.nextCursor}`).set(auth('viewer'))).body);
      expect(p3.nextCursor).toBeNull();
      expect(new Set([...p1.items, ...p2.items, ...p3.items].map((l) => l.id)).size).toBe(29);
      const red = BoqViewSchema.parse((await http.get(`${base()}?level=red`).set(auth('viewer'))).body);
      expect(red.items.map((l) => l.code)).toEqual(['4.12']);
      const ch8 = BoqViewSchema.parse((await http.get(`${base()}?chapter=8`).set(auth('viewer'))).body);
      expect(ch8.items.map((l) => l.code)).toEqual(['9.01']);
      expect((await http.get(`${base()}?limit=501`).set(auth('viewer'))).status).toBe(400);
      expect((await http.get(`${base()}?level=purple`).set(auth('viewer'))).status).toBe(400);
    });

    it('cross-org: outsider 404 on our project, our users 404 on theirs', async () => {
      expect((await http.get(base()).set(auth('outsider'))).status).toBe(404);
      expect((await http.get(base(otherProject)).set(auth('admin'))).status).toBe(404);
    });
  });

  // ---------------------------------------------------------------- PATCH
  describe('PATCH /boq/lines/:lineId', () => {
    const url = (id: string, p = projectId) => `${base(p)}/lines/${id}`;

    it('roles: viewer 403; reviewer may change status/note but not qtyOverride; outsider 404', async () => {
      expect((await http.patch(url('bl_4_00')).set(auth('viewer')).send({ status: 'reviewed' })).status).toBe(403);
      expect((await http.patch(url('bl_4_00')).set(auth('reviewer')).send({ qtyOverride: 3, reason: 'x' })).status).toBe(403);
      expect((await http.patch(url('bl_4_00')).set(auth('outsider')).send({ status: 'reviewed' })).status).toBe(404);
      expect((await http.patch(url('bl_4_00', otherProject)).set(auth('admin')).send({ status: 'reviewed' })).status).toBe(404);
      const r = await http.patch(url('bl_4_00')).set(auth('reviewer')).send({ status: 'reviewed', note: 'נבדק מול השרטוט' });
      expect(r.status).toBe(200);
      expect(PatchBoqLineResponseSchema.parse(r.body).line).toMatchObject({ status: 'reviewed', reviewedBy: 'reviewer', note: 'נבדק מול השרטוט' });
      // the other org's identical line is untouched
      expect((t.repo.docs.get(fsPaths.boqLine(otherOrg, otherProject, 'bl_4_00')) as Doc).status).toBe('draft');
    });

    it('state machine over HTTP: skip → 409; approve → locked; un-approve; validation 400; unknown line 404', async () => {
      const skip = await http.patch(url('bl_4_01')).set(auth('reviewer')).send({ status: 'approved' });
      expect(skip.status).toBe(409);
      expect(ApiErrorSchema.parse(skip.body).error.code).toBe('conflict');
      expect((await http.patch(url('bl_4_01')).set(auth('reviewer')).send({ status: 'reviewed' })).status).toBe(200);
      const appr = await http.patch(url('bl_4_01')).set(auth('admin')).send({ status: 'approved' });
      expect(PatchBoqLineResponseSchema.parse(appr.body).line).toMatchObject({ status: 'approved', approvedBy: 'admin' });
      expect((await http.patch(url('bl_4_01')).set(auth('reviewer')).send({ note: 'x' })).status).toBe(409);
      const un = await http.patch(url('bl_4_01')).set(auth('reviewer')).send({ status: 'reviewed' });
      expect(PatchBoqLineResponseSchema.parse(un.body).line).toMatchObject({ status: 'reviewed', approvedBy: null });
      // override on an approved line → back to reviewed (re-approval required) + reason chip
      expect((await http.patch(url('bl_4_01')).set(auth('admin')).send({ status: 'approved' })).status).toBe(200);
      const ov = await http.patch(url('bl_4_01')).set(auth('editor')).send({ qtyOverride: 16, reason: 'ספירה ידנית' });
      expect(PatchBoqLineResponseSchema.parse(ov.body).line).toMatchObject({ status: 'reviewed', approvedBy: null, qtyOverride: 16 });
      expect(PatchBoqLineResponseSchema.parse(ov.body).line.reasons).toContain('כמות שונתה ידנית');
      expect((await http.patch(url('bl_4_01')).set(auth('editor')).send({ qtyOverride: null })).status).toBe(200);
      expect((await http.patch(url('bl_4_01')).set(auth('editor')).send({ qtyOverride: 3 })).status).toBe(400); // reason required
      expect((await http.patch(url('bl_4_01')).set(auth('editor')).send({ qty: 3 })).status).toBe(400); // strict
      expect((await http.patch(url('bl_4_01')).set(auth('editor')).send({})).status).toBe(400);
      expect((await http.patch(url('nope')).set(auth('editor')).send({ status: 'reviewed' })).status).toBe(404);
      expect((await http.patch(url('a.b')).set(auth('editor')).send({ status: 'reviewed' })).status).toBe(404);
    });

    it('editor override: stored with reason/by/at, audited without note text, preserved across a worker rebuild', async () => {
      const r = await http.patch(url('bl_4_03')).set(auth('editor')).send({ qtyOverride: 9, reason: 'שקע נוסף במחסן', note: 'פרטי' });
      expect(r.status).toBe(200);
      expect(PatchBoqLineResponseSchema.parse(r.body).line).toMatchObject({ qty: 8, qtyOverride: 9, qtyOverrideReason: 'שקע נוסף במחסן', qtyOverrideBy: 'editor' });
      const ev = audits(orgId).at(-1) as Doc;
      expect(ev).toMatchObject({ entity: 'boqLines', entityId: 'bl_4_03', action: 'update', actorId: 'editor' });
      expect(ev.after).toMatchObject({ qty: 8, qtyOverride: 9, noteChanged: true });
      expect(JSON.stringify(ev)).not.toContain('פרטי');

      // worker rebuild rewrites computed fields only (contracts applyRebuild = the worker's documented behaviour)
      const path = fsPaths.boqLine(orgId, projectId, 'bl_4_03');
      const cur = t.repo.docs.get(path) as Doc;
      t.repo.docs.set(path, applyRebuild(cur, { chapter: '04', code: '4.03', description: 'שקע כח', qty: 10, unit: 'יחידה', level: 'green', byFloor: { 'קומת קרקע': 10 }, computedAt: new Date() }));
      const v = BoqViewSchema.parse((await http.get(base()).set(auth('viewer'))).body);
      expect(v.items.find((l) => l.id === 'bl_4_03')).toMatchObject({ qty: 10, qtyOverride: 9, qtyOverrideReason: 'שקע נוסף במחסן', note: 'פרטי' });

      // clearing
      const c = await http.patch(url('bl_4_03')).set(auth('editor')).send({ qtyOverride: null });
      expect(PatchBoqLineResponseSchema.parse(c.body).line).toMatchObject({ qtyOverride: null, qtyOverrideReason: null });
      await http.patch(url('bl_4_03')).set(auth('editor')).send({ qtyOverride: 9, reason: 'שקע נוסף במחסן' });
    });
  });

  // ---------------------------------------------------------------- evidence
  describe('GET /boq/lines/:lineId/evidence', () => {
    const items = (n: number, sheetId: string, floor: string) =>
      Array.from({ length: n }, (_, i) => ({ sheetId, versionId: 'v1', detectionId: `d_${sheetId}_${i}`, linkGroupId: i % 2 ? `lk_${i}` : null, floor }));

    beforeAll(() => {
      const latest = ((t.repo.docs.get(fsPaths.project(orgId, projectId)) as Doc).boq as Doc).latestBuildId as string;
      t.boqStorage.putEvidence(storagePaths.boqEvidence(orgId, projectId, latest), {
        schema: 'kamutan.boq-evidence/1',
        lines: { bl_4_10: [...items(3, 'light-g', 'קומת קרקע'), ...items(2, 'light-1', "קומה א'")], bl_4_00: [{ bogus: true }] },
      });
      t.repo.seedWorkerSheet(orgId, projectId, 'light', 0, { title: 'תאורה קומת קרקע' });
      t.artifacts.putJson(storagePaths.links(orgId, projectId, 'light-g', 'v1'), {
        schema: 'kamutan.links/1',
        groups: [{ id: 'lk_1', kind: 'two_way', switchIds: ['d_light-g_1', 'd_x'], pointIds: ['pt_1'], luminaireIds: ['d_l'], confidence: 0.9, level: 'green', reasons: [] }],
      });
    });

    it('returns the line items and per-sheet groups (latest build when evidenceRef is unset)', async () => {
      const r = await http.get(`${base()}/lines/bl_4_10/evidence`).set(auth('viewer'));
      expect(r.status).toBe(200);
      const ev = BoqLineEvidenceResponseSchema.parse(r.body);
      expect(ev.items).toHaveLength(5);
      expect(ev.bySheet).toEqual([
        { sheetId: 'light-g', versionId: 'v1', floor: 'קומת קרקע', count: 3 },
        { sheetId: 'light-1', versionId: 'v1', floor: "קומה א'", count: 2 },
      ]);
      expect(ev.truncated).toBe(false);
      // composite: lk_1 is one unit; ids come from the version's links.json.gz (absent for light-1 → empty ids)
      expect(ev.linkGroups).toEqual([
        { sheetId: 'light-g', versionId: 'v1', linkGroupId: 'lk_1', floor: 'קומת קרקע', kind: 'two_way', switchIds: ['d_light-g_1', 'd_x'], pointIds: ['pt_1'], luminaireIds: ['d_l'] },
        { sheetId: 'light-1', versionId: 'v1', linkGroupId: 'lk_1', floor: "קומה א'", kind: null, switchIds: [], pointIds: [], luminaireIds: [] },
      ]);
    });

    it('malformed items → empty; line without evidence → empty; foreign evidenceRef is never read', async () => {
      expect(BoqLineEvidenceResponseSchema.parse((await http.get(`${base()}/lines/bl_4_00/evidence`).set(auth('viewer'))).body).items).toEqual([]);
      expect(BoqLineEvidenceResponseSchema.parse((await http.get(`${base()}/lines/bl_4_11/evidence`).set(auth('viewer'))).body).items).toEqual([]);
      // a line pointing at ANOTHER org's evidence file: ignored (falls back to this project's latest build)
      t.boqStorage.putEvidence(storagePaths.boqEvidence(otherOrg, otherProject, 'b1'), { schema: 'kamutan.boq-evidence/1', lines: { bl_4_02: items(4, 'secret', 'x') } });
      const p = fsPaths.boqLine(orgId, projectId, 'bl_4_02');
      t.repo.docs.set(p, { ...(t.repo.docs.get(p) as Doc), evidenceRef: storagePaths.boqEvidence(otherOrg, otherProject, 'b1') });
      const ev = BoqLineEvidenceResponseSchema.parse((await http.get(`${base()}/lines/bl_4_02/evidence`).set(auth('viewer'))).body);
      expect(ev.items).toEqual([]);
      expect((await http.get(`${base(otherProject)}/lines/bl_4_02/evidence`).set(auth('admin'))).status).toBe(404);
      expect((await http.get(`${base()}/lines/nope/evidence`).set(auth('viewer'))).status).toBe(404);
    });
  });

  // ---------------------------------------------------------------- bulk evidence
  describe('GET /boq/evidence?sheetId=&versionId=', () => {
    it('maps detection / link-group ids of one sheet version to lines; other versions excluded; cross-org 404', async () => {
      const r = await http.get(`${base()}/evidence?sheetId=light-g&versionId=v1`).set(auth('viewer'));
      expect(r.status).toBe(200);
      const ev = BoqSheetEvidenceResponseSchema.parse(r.body);
      expect(Object.keys(ev.detections).sort()).toEqual(['d_light-g_0', 'd_light-g_1', 'd_light-g_2']);
      expect(ev.detections['d_light-g_0']).toEqual(['bl_4_10']);
      expect(ev.linkGroups).toEqual({ lk_1: ['bl_4_10'] });
      expect(BoqSheetEvidenceResponseSchema.parse((await http.get(`${base()}/evidence?sheetId=light-g&versionId=v9`).set(auth('viewer'))).body).detections).toEqual({});
      expect((await http.get(`${base()}/evidence?sheetId=light-g`).set(auth('viewer'))).status).toBe(400);
      expect((await http.get(`${base()}/evidence?sheetId=light-g&versionId=v1`).set(auth('outsider'))).status).toBe(404);
    });
  });

  // ---------------------------------------------------------------- export
  describe('POST /boq/export', () => {
    beforeEach(() => setBlock(true));

    it('viewer / reviewer 403; outsider 404', async () => {
      for (const who of ['viewer', 'reviewer']) expect((await http.post(`${base()}/export`).set(auth(who)).send({})).status).toBe(403);
      expect((await http.post(`${base()}/export`).set(auth('outsider')).send({})).status).toBe(404);
    });

    it('blockExportOnRed + a red line → 409 export_blocked with the count', async () => {
      const r = await http.post(`${base()}/export`).set(auth('editor')).send({});
      expect(r.status).toBe(409);
      const e = ApiErrorSchema.parse(r.body).error;
      expect(e.code).toBe('export_blocked');
      expect(e.issues).toEqual([{ path: 'red', message: '1' }]);
    });

    it('exports xlsx (warning row, override, evidence sheet), signed 2-min URL, record + audit', async () => {
      setBlock(false);
      const r = await http.post(`${base()}/export`).set(auth('editor')).send({ split: 'summed', markDraft: true });
      expect(r.status).toBe(200);
      const body = ExportBoqResponseSchema.parse(r.body);
      expect(body.hasWarnings).toBe(true);
      expect(body.counts).toMatchObject({ lines: 29, red: 1 });
      expect(body.url).toContain('X-Goog-Expires=120');
      expect(body.url).toContain(encodeURIComponent(`orgs/${orgId}/projects/${projectId}/exports/${body.exportId}.xlsx`).replace(/%2F/g, '/'));
      expect(Date.parse(body.expiresAt) - Date.now()).toBeLessThanOrEqual(120_000);
      expect(body.fileName).toMatch(/^כתב כמויות - בית משפחת נח - \d\d\.\d\d\.\d{4}\.xlsx$/);

      const path = storagePaths.boqExportFile(orgId, projectId, body.exportId);
      const file = t.boqStorage.objects.get(path) as Buffer;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(file as unknown as ArrayBuffer);
      const ws = wb.getWorksheet(MAIN_SHEET) as ExcelJS.Worksheet;
      expect(ws.views[0]?.rightToLeft).toBe(true);
      expect(String(ws.getCell(1, 1).value)).toContain('שורות "לבדיקה"');
      expect(ws.getCell(4, 1).value).toBe('טיוטה – כולל פריטים שלא אומתו');
      let r403: ExcelJS.Row | undefined;
      ws.eachRow((row) => {
        if (row.getCell(1).value === '4.03') r403 = row;
      });
      expect(r403?.getCell(4).value).toBe(9); // override wins over the rebuilt qty 10
      const ev = wb.getWorksheet('ראיות') as ExcelJS.Worksheet;
      const evTexts: unknown[] = [];
      ev.eachRow((row) => evTexts.push(row.getCell(3).value));
      expect(evTexts).toContain('light-1'); // no sheet doc → id
      expect(evTexts).not.toContain('secret');

      const rec = t.repo.docs.get(fsPaths.boqExport(orgId, projectId, body.exportId)) as Doc;
      expect(rec).toMatchObject({ templateId: 'tpl_default', split: 'summed', markDraft: true, storagePath: path, createdBy: 'editor', sizeBytes: file.length });
      expect(audits(orgId).at(-1)).toMatchObject({ entity: 'exports', action: 'create', entityId: body.exportId, actorId: 'editor' });
    });

    it('byFloor split and an explicit template; unknown template 404; strict body', async () => {
      setBlock(false);
      const r = await http.post(`${base()}/export`).set(auth('admin')).send({ split: 'byFloor', templateId: 'tpl_default' });
      expect(r.status).toBe(200);
      expect((await http.post(`${base()}/export`).set(auth('admin')).send({ templateId: 'nope' })).status).toBe(404);
      expect((await http.post(`${base()}/export`).set(auth('admin')).send({ split: 'perRoom' })).status).toBe(400);
      expect((await http.post(`${base()}/export`).set(auth('admin')).send({ evil: 1 })).status).toBe(400);
    });

    it('no lines → 409 not_ready', async () => {
      const empty = (await t.repo.createProject(orgId, { name: 'empty' }, 'editor')).id;
      const r = await http.post(`${base(empty)}/export`).set(auth('editor')).send({});
      expect(r.status).toBe(409);
      expect(ApiErrorSchema.parse(r.body).error.code).toBe('not_ready');
    });

    it('per-user export rate limit → 429', async () => {
      setBlock(false);
      const codes: number[] = [];
      for (let i = 0; i < 9; i++) codes.push((await http.post(`${base()}/export`).set(auth('editor2')).send({})).status);
      expect(codes).toContain(429);
      expect(codes.filter((c) => c === 200).length).toBeLessThanOrEqual(8);
    });
  });

  // ---------------------------------------------------------------- stale
  describe('stale flag', () => {
    it('legend confirm, sheet confirm and rule changes mark the BOQ stale', async () => {
      const reset = () => t.repo.docs.set(fsPaths.project(orgId, projectId), { ...projectDoc(), boq: { ...(projectDoc().boq as Doc), stale: false, staleReason: null } });
      const stale = () => projectDoc().boq as Doc;

      reset();
      const { sheetId, versionId } = t.repo.seedWorkerSheet(orgId, projectId, 'elec', 0, { floors: ['קומת קרקע'] });
      t.repo.seedLegendEntry(orgId, projectId, `le_${sheetId}_0`, { sheetId, versionId, signature: 'a1'.repeat(20) });
      expect((await http.patch(`/api/v1/projects/${projectId}/legend-entries/le_${sheetId}_0`).set(auth('editor')).send({ action: 'confirm' })).status).toBe(200);
      expect(stale()).toMatchObject({ stale: true, staleReason: 'legend' });

      reset();
      const conf = await http.post(`/api/v1/projects/${projectId}/sheets/${sheetId}/confirm`).set(auth('editor')).send({ discipline: 'electrical', floors: ['קומת קרקע'], scaleDenominator: 50 });
      expect(conf.status).toBe(200);
      expect(stale()).toMatchObject({ stale: true, staleReason: 'sheet' });

      reset();
      expect((await http.patch(`/api/v1/boq-rules/r_socket_single?orgId=${orgId}`).set(auth('admin')).send({ enabled: false })).status).toBe(200);
      expect(stale()).toMatchObject({ stale: true, staleReason: 'rule' });
      expect(BoqViewSchema.parse((await http.get(base()).set(auth('viewer'))).body).summary).toMatchObject({ stale: true, staleReason: 'rule' });
      // the other org's projects are untouched
      expect((t.repo.docs.get(fsPaths.project(otherOrg, otherProject)) as Doc).boq).toBeUndefined();
    });
  });
});
