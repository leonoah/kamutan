import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  AuditPageSchema,
  AuditVerifyResponseSchema,
  CreateMarkedPdfResponseSchema,
  ExportStatusResponseSchema,
  fsPaths,
  JobSchema,
  LineHistoryResponseSchema,
  MarkedPdfJobSchema,
  PatchOrgSettingsResponseSchema,
  storagePaths,
} from '@kamutan/contracts';
import type { Doc } from '../../src/db/mappers';
import { toJob } from '../../src/db/mappers';
import { createTestApp, type TestApp } from '../support/app';
import { testConfig } from '../support/helpers';
import { det, seedSheet } from '../support/review-fixtures';

describe('Sprint 5 e2e — line history, audit log + verify, marked PDF, org settings', () => {
  let t: TestApp;
  let http: ReturnType<typeof request>;
  const tok: Record<string, string> = {};
  let orgId: string;
  let otherOrg: string;
  let projectId: string;
  let otherProject: string;
  let sheet: { sheetId: string; versionId: string };
  const auth = (who: string) => ({ authorization: `Bearer ${tok[who]}` });
  const P = (p = projectId) => `/api/v1/projects/${p}`;
  const O = (o = orgId) => `/api/v1/orgs/${o}`;
  const audits = (o = orgId) =>
    [...t.repo.docs.entries()]
      .filter(([k]) => k.startsWith(`orgs/${o}/auditLog/`))
      .map(([k, v]) => ({ ...v, id: k.split('/').at(-1) as string }) as Doc & { id: string })
      .sort((a, b) => (a.at as Date).getTime() - (b.at as Date).getTime());
  const setLatestBuild = (buildId: string | null) => {
    const p = t.repo.docs.get(fsPaths.project(orgId, projectId)) as Doc;
    t.repo.docs.set(fsPaths.project(orgId, projectId), { ...p, boq: { latestBuildId: buildId, builtAt: new Date(), stale: false } });
  };

  beforeAll(async () => {
    t = await createTestApp(testConfig({ THROTTLE_LIMIT: '1000', UPLOAD_THROTTLE_LIMIT: '200', EXPORT_THROTTLE_LIMIT: '100' }));
    http = request(t.app.getHttpServer());
    for (const who of ['admin', 'editor', 'reviewer', 'viewer', 'outsider']) tok[who] = t.auth.issue(who);
    orgId = t.repo.seedOrg('Org', { admin: 'admin', editor: 'editor', reviewer: 'reviewer', viewer: 'viewer' }).id;
    t.repo.docs.set(fsPaths.member(orgId, 'editor'), { uid: 'editor', role: 'editor', displayName: 'עורכת ראשית', createdAt: new Date() });
    otherOrg = t.repo.seedOrg('Other', { outsider: 'admin' }).id;
    projectId = (await t.repo.createProject(orgId, { name: 'בית משפחת נח' }, 'editor')).id;
    otherProject = (await t.repo.createProject(otherOrg, { name: 'Q' }, 'outsider')).id;
    sheet = seedSheet(t, orgId, projectId, 'setA', { detections: [det('d_1', 'socket_double', 50, 50, 0.7, 'yellow'), det('d_2', 'socket_double', 60, 50, 0.99, 'green')] });
    t.boq.seedLine(orgId, projectId, { id: 'bl_4_01', code: '4.01', description: 'שקע כפול', qty: 2, level: 'yellow', status: 'draft', buildId: 'b1' });
    t.boq.seedLine(orgId, projectId, { id: 'bl_4_09', code: '4.09', description: "נק' מאור", qty: 3, level: 'green', status: 'draft', buildId: 'b1' });
    t.boq.seedLine(otherOrg, otherProject, { id: 'bl_4_01', code: '4.01', qty: 1 });
    t.boqStorage.putEvidence(storagePaths.boqEvidence(orgId, projectId, 'b1'), {
      schema: 'kamutan.boq-evidence/1',
      lines: { bl_4_01: [{ sheetId: sheet.sheetId, versionId: sheet.versionId, detectionId: 'd_1', linkGroupId: null, floor: '0' }] },
    });
    setLatestBuild('b1');
  });
  afterAll(async () => {
    await t.app.close();
  });

  // ---------------------------------------------------------------- history (FR-26 / E2E-11)
  describe('line history', () => {
    it('E2E-11: approved → editor override → reviewed; history newest first with before/after, name, time, reason', async () => {
      const url = `${P()}/boq/lines/bl_4_01`;
      expect((await http.patch(url).set(auth('reviewer')).send({ status: 'reviewed' })).status).toBe(200);
      expect((await http.patch(url).set(auth('reviewer')).send({ status: 'approved' })).status).toBe(200);
      const o = await http.patch(url).set(auth('editor')).send({ qtyOverride: 3, reason: 'שקע נוסף במחסן' });
      expect(o.status).toBe(200);
      expect(o.body.line.status).toBe('reviewed'); // Sprint-3 decision (documented deviation from E2E-11 "טיוטה")
      expect((await http.patch(url).set(auth('reviewer')).send({ note: 'טקסט פרטי' })).status).toBe(200);
      // a correction on one of its evidence detections + one by item code + one unrelated
      const corr = (body: Record<string, unknown>, who = 'editor') => http.post(`${P()}/corrections`).set(auth(who)).send({ sheetId: sheet.sheetId, versionId: sheet.versionId, anchorMm: { x: 50, y: 50 }, ...body });
      expect((await corr({ kind: 'reject', detectionId: 'd_1', reason: 'כפול' }, 'reviewer')).status).toBe(201);
      expect((await corr({ kind: 'add', class: 'socket_double', itemCode: '4.01' })).status).toBe(201);
      expect((await corr({ kind: 'add', class: 'socket_single', itemCode: '4.00' })).status).toBe(201);

      const r = await http.get(`${url}/history`).set(auth('reviewer'));
      expect(r.status).toBe(200);
      const h = LineHistoryResponseSchema.parse(r.body);
      expect(h.items.map((i) => i.action)).toEqual(['correction', 'correction', 'note', 'status', 'qtyOverride', 'status', 'status']);
      const ats = h.items.map((i) => i.at);
      expect([...ats].sort().reverse()).toEqual(ats);
      const override = h.items.find((i) => i.action === 'qtyOverride');
      expect(override).toMatchObject({ before: null, after: 3, reason: 'שקע נוסף במחסן', by: { uid: 'editor', displayName: 'עורכת ראשית' } });
      expect(h.items.filter((i) => i.action === 'status').map((i) => [i.before, i.after])).toEqual([
        ['approved', 'reviewed'],
        ['reviewed', 'approved'],
        ['draft', 'reviewed'],
      ]);
      expect(h.items.find((i) => i.action === 'note')).toMatchObject({ before: null, after: null });
      expect(JSON.stringify(h)).not.toContain('טקסט פרטי');
      const corrections = h.items.filter((i) => i.action === 'correction');
      expect(corrections.map((c) => (c.after as Doc).kind).sort()).toEqual(['add', 'reject']);
      expect(corrections.find((c) => (c.after as Doc).kind === 'reject')).toMatchObject({ reason: 'כפול', by: { uid: 'reviewer' } });
    });

    it('roles + isolation: viewer 403, outsider / other org / unknown line 404, other line has its own history', async () => {
      expect((await http.get(`${P()}/boq/lines/bl_4_01/history`).set(auth('viewer'))).status).toBe(403);
      expect((await http.get(`${P()}/boq/lines/bl_4_01/history`).set(auth('outsider'))).status).toBe(404);
      expect((await http.get(`${P(otherProject)}/boq/lines/bl_4_01/history`).set(auth('admin'))).status).toBe(404);
      expect((await http.get(`${P()}/boq/lines/nope/history`).set(auth('admin'))).status).toBe(404);
      expect((await http.get(`${P()}/boq/lines/bl_4_01/history`)).status).toBe(401);
      const other = LineHistoryResponseSchema.parse((await http.get(`${P()}/boq/lines/bl_4_09/history`).set(auth('admin'))).body);
      expect(other.items).toEqual([]);
    });
  });

  // ---------------------------------------------------------------- audit log + verify (SEC-35)
  describe('audit log', () => {
    it('admin only; newest first; paginated by cursor; entity / action / entityId filters; actor names', async () => {
      expect((await http.get(`${O()}/audit`).set(auth('editor'))).status).toBe(403);
      expect((await http.get(`${O()}/audit`).set(auth('viewer'))).status).toBe(403);
      expect((await http.get(`${O()}/audit`).set(auth('outsider'))).status).toBe(404);
      expect((await http.get(`${O(otherOrg)}/audit`).set(auth('admin'))).status).toBe(404);
      const all = audits();
      const p1 = AuditPageSchema.parse((await http.get(`${O()}/audit?limit=3`).set(auth('admin'))).body);
      expect(p1.items.map((e) => e.id)).toEqual(all.slice(-3).reverse().map((e) => e.id));
      expect(p1.nextCursor).toBe(p1.items[2]?.id);
      const p2 = AuditPageSchema.parse((await http.get(`${O()}/audit?limit=3&cursor=${p1.nextCursor}`).set(auth('admin'))).body);
      expect(p2.items.map((e) => e.id)).toEqual(all.slice(-6, -3).reverse().map((e) => e.id));
      const lines = AuditPageSchema.parse((await http.get(`${O()}/audit?entity=boqLines&limit=200`).set(auth('admin'))).body);
      expect(lines.items.length).toBe(4);
      expect(lines.items.every((e) => e.entity === 'boqLines' && e.entityId === 'bl_4_01')).toBe(true);
      expect(lines.items.find((e) => e.actorId === 'editor')?.actorName).toBe('עורכת ראשית');
      const byId = AuditPageSchema.parse((await http.get(`${O()}/audit?entityId=bl_4_01&action=update`).set(auth('admin'))).body);
      expect(byId.items.length).toBe(4);
      expect(byId.nextCursor).toBeNull();
      expect((await http.get(`${O()}/audit?entity=a%20b`).set(auth('admin'))).status).toBe(400);
      expect((await http.get(`${O()}/audit?limit=500`).set(auth('admin'))).status).toBe(400);
      expect((await http.get(`${O()}/audit?x=1`).set(auth('admin'))).status).toBe(400);
    });

    it('verify: ok on an untouched chain; detects a tampered record, a deleted record and a forged insert', async () => {
      expect((await http.get(`${O()}/audit/verify`).set(auth('editor'))).status).toBe(403);
      const ok = AuditVerifyResponseSchema.parse((await http.get(`${O()}/audit/verify`).set(auth('admin'))).body);
      expect(ok).toMatchObject({ ok: true, brokenAt: null, checked: audits().length });
      expect(ok.headHash).toBe(audits().at(-1)?.hash);

      const victim = audits()[3] as Doc & { id: string };
      const key = fsPaths.auditEvent(orgId, victim.id);
      const orig = t.repo.docs.get(key) as Doc;
      // 1) tampered payload
      t.repo.docs.set(key, { ...orig, after: { ...(orig.after as Doc), qtyOverride: 999 } });
      const bad = AuditVerifyResponseSchema.parse((await http.get(`${O()}/audit/verify`).set(auth('admin'))).body);
      expect(bad).toMatchObject({ ok: false, brokenAt: victim.id });
      // 2) deleted record → the next one's prevHash points nowhere
      t.repo.docs.delete(key);
      const del = AuditVerifyResponseSchema.parse((await http.get(`${O()}/audit/verify`).set(auth('admin'))).body);
      expect(del.ok).toBe(false);
      expect(del.brokenAt).toBe((audits()[3] as { id: string }).id);
      t.repo.docs.set(key, orig);
      expect(AuditVerifyResponseSchema.parse((await http.get(`${O()}/audit/verify`).set(auth('admin'))).body).ok).toBe(true);
      // 3) a second event claiming the same predecessor (fork / forged insert)
      const forged = { ...(audits()[5] as Doc) };
      delete forged.id;
      t.repo.docs.set(fsPaths.auditEvent(orgId, 'forged0000000000000'), { ...forged, at: new Date((forged.at as Date).getTime() + 1) });
      const fork = AuditVerifyResponseSchema.parse((await http.get(`${O()}/audit/verify`).set(auth('admin'))).body);
      expect(fork.ok).toBe(false);
      t.repo.docs.delete(fsPaths.auditEvent(orgId, 'forged0000000000000'));
    });
  });

  // ---------------------------------------------------------------- marked PDF (FR-29 / E2E-13)
  describe('marked PDF export', () => {
    it('editor → 202 {exportId, jobId}; export doc + job + audit; contract-valid `export.marked_pdf` message', async () => {
      const before = t.queue.messages.length;
      const r = await http.post(`${P()}/boq/export/marked-pdf`).set(auth('editor')).send({ options: { floorSplit: true, hideTitleBlock: true } });
      expect(r.status).toBe(202);
      const { exportId, jobId } = CreateMarkedPdfResponseSchema.parse(r.body);
      expect(t.repo.docs.get(fsPaths.boqExport(orgId, projectId, exportId))).toMatchObject({ kind: 'marked_pdf', status: 'queued', createdBy: 'editor', storagePath: storagePaths.markedPdf(orgId, projectId, exportId) });
      expect(JobSchema.parse(toJob(jobId, t.repo.docs.get(fsPaths.job(jobId)) as Doc))).toMatchObject({ type: 'export.marked_pdf', orgId, projectId, exportId });
      expect(t.queue.messages.length).toBe(before + 1);
      const msg = MarkedPdfJobSchema.parse(t.queue.messages.at(-1)?.data);
      expect(msg).toMatchObject({ orgId, projectId, exportId, jobId, sheetIds: null, versionIds: null, options: { legend: true, floorSplit: true, watermark: null, hideTitleBlock: true } });
      expect(t.queue.messages.at(-1)?.attributes).toMatchObject({ type: 'export.marked_pdf', orgId, jobId });
      expect(audits().at(-1)).toMatchObject({ entity: 'exports', entityId: exportId, action: 'create', actorId: 'editor' });
    });

    it('status: queued → url null; worker ready → 15-min signed URL (+ download audit); failed carries the error', async () => {
      const { exportId } = CreateMarkedPdfResponseSchema.parse((await http.post(`${P()}/boq/export/marked-pdf`).set(auth('admin')).send({ sheetIds: [sheet.sheetId] })).body);
      const q = ExportStatusResponseSchema.parse((await http.get(`${P()}/exports/${exportId}`).set(auth('viewer'))).body);
      expect(q).toMatchObject({ export: { kind: 'marked_pdf', status: 'queued', sheetIds: [sheet.sheetId] }, url: null, expiresAt: null });
      // worker finishes
      const path = fsPaths.boqExport(orgId, projectId, exportId);
      t.repo.docs.set(path, { ...(t.repo.docs.get(path) as Doc), status: 'succeeded', pageCount: 4, sizeBytes: 1234, finishedAt: new Date() });
      t.govStorage.putMarkedPdf(storagePaths.markedPdf(orgId, projectId, exportId), Buffer.from('%PDF-1.7'));
      const r = ExportStatusResponseSchema.parse((await http.get(`${P()}/exports/${exportId}`).set(auth('viewer'))).body);
      expect(r.export).toMatchObject({ status: 'ready', pageCount: 4 });
      expect(r.url).toContain(encodeURI(storagePaths.markedPdf(orgId, projectId, exportId)));
      expect(r.url).toContain('X-Goog-Expires=900');
      expect(Date.parse(r.expiresAt as string) - Date.now()).toBeGreaterThan(14 * 60_000);
      expect(r.fileName).toMatch(/\.pdf$/);
      expect(audits().at(-1)).toMatchObject({ entity: 'exports', action: 'download', entityId: exportId, actorId: 'viewer' });
      // worker failure is surfaced
      t.repo.docs.set(path, { ...(t.repo.docs.get(path) as Doc), status: 'failed', error: { code: 'render_failed', message: 'x' } });
      expect(ExportStatusResponseSchema.parse((await http.get(`${P()}/exports/${exportId}`).set(auth('viewer'))).body)).toMatchObject({ export: { status: 'failed', error: { code: 'render_failed' } }, url: null });
    });

    it('Sprint-3 xlsx export records are readable through the same endpoint (2-minute URL)', async () => {
      const x = await http.post(`${P()}/boq/export`).set(auth('editor')).send({});
      expect(x.status).toBe(200);
      const r = ExportStatusResponseSchema.parse((await http.get(`${P()}/exports/${x.body.exportId}`).set(auth('reviewer'))).body);
      expect(r.export).toMatchObject({ kind: 'xlsx', status: 'ready' });
      expect(r.url).toContain('X-Goog-Expires=120');
    });

    it('roles / validation / isolation: reviewer 403, unknown sheet 404, no build 409, strict body, other org 404, publish failure 503', async () => {
      expect((await http.post(`${P()}/boq/export/marked-pdf`).set(auth('reviewer')).send({})).status).toBe(403);
      expect((await http.post(`${P()}/boq/export/marked-pdf`).set(auth('viewer')).send({})).status).toBe(403);
      expect((await http.post(`${P()}/boq/export/marked-pdf`).set(auth('outsider')).send({})).status).toBe(404);
      expect((await http.post(`${P(otherProject)}/boq/export/marked-pdf`).set(auth('admin')).send({})).status).toBe(404);
      expect((await http.post(`${P()}/boq/export/marked-pdf`).set(auth('editor')).send({ sheetIds: ['nope'] })).status).toBe(404);
      expect((await http.post(`${P()}/boq/export/marked-pdf`).set(auth('editor')).send({ options: { legend: false } })).status).toBe(400);
      expect((await http.post(`${P()}/boq/export/marked-pdf`).set(auth('editor')).send({ x: 1 })).status).toBe(400);
      expect((await http.get(`${P()}/exports/nope`).set(auth('editor'))).status).toBe(404);
      expect((await http.get(`${P(otherProject)}/exports/nope`).set(auth('editor'))).status).toBe(404);
      setLatestBuild(null);
      const nb = await http.post(`${P()}/boq/export/marked-pdf`).set(auth('editor')).send({});
      expect(nb.status).toBe(409);
      expect(ApiErrorSchema.parse(nb.body).error.code).toBe('not_ready');
      setLatestBuild('b1');
      const pub = t.queue.publish.bind(t.queue);
      t.queue.publish = async () => {
        throw new Error('down');
      };
      try {
        const r = await http.post(`${P()}/boq/export/marked-pdf`).set(auth('editor')).send({});
        expect(r.status).toBe(503);
        const failed = [...t.repo.docs.entries()].filter(([k, v]) => k.startsWith(`orgs/${orgId}/projects/${projectId}/exports/`) && v.status === 'failed');
        expect(failed.some(([, v]) => (v.error as Doc).code === 'publish_failed')).toBe(true);
      } finally {
        t.queue.publish = pub;
      }
    });
  });

  // ---------------------------------------------------------------- org settings (FR-31)
  describe('org settings', () => {
    it('admin PATCH → settings + audit {field: {from, to}} + every project stale; editor 403; outsider 404', async () => {
      const r = await http.patch(`${O()}/settings`).set(auth('admin')).send({ greenThreshold: 0.99, trainingOptIn: true, llmEnabled: false });
      expect(r.status).toBe(200);
      const body = PatchOrgSettingsResponseSchema.parse(r.body);
      expect(body.settings).toMatchObject({ greenThreshold: 0.99, trainingOptIn: true, llmEnabled: false, blockExportOnRed: true });
      expect((t.repo.docs.get(fsPaths.org(orgId)) as Doc).settings).toMatchObject({ greenThreshold: 0.99, trainingOptIn: true });
      const ev = audits().at(-1) as Doc;
      expect(ev).toMatchObject({ entity: 'orgs', action: 'update_settings', entityId: orgId, actorId: 'admin' });
      expect(ev.after).toEqual({ changes: { greenThreshold: { from: 0.98, to: 0.99 }, trainingOptIn: { from: false, to: true } } });
      expect((t.repo.docs.get(fsPaths.project(orgId, projectId)) as Doc).boq).toMatchObject({ stale: true, staleReason: 'rule' });
      expect((await http.patch(`${O()}/settings`).set(auth('editor')).send({ llmEnabled: true })).status).toBe(403);
      expect((await http.patch(`${O()}/settings`).set(auth('outsider')).send({ llmEnabled: true })).status).toBe(404);
      expect((await http.patch(`${O(otherOrg)}/settings`).set(auth('admin')).send({ llmEnabled: true })).status).toBe(404);
    });

    it('validates ranges and keys: greenThreshold 0.9–0.995, strict body, at least one field', async () => {
      for (const body of [{ greenThreshold: 0.5 }, { greenThreshold: 0.999 }, { greenThreshold: 'x' }, { vatRate: 0.2 }, {}, { llmEnabled: 'yes' }]) {
        const r = await http.patch(`${O()}/settings`).set(auth('admin')).send(body);
        expect(r.status, JSON.stringify(body)).toBe(400);
      }
      expect((await http.patch(`${O()}/settings`).set(auth('admin')).send({ greenThreshold: 0.9 })).status).toBe(200);
      expect((await http.patch(`${O()}/settings`).set(auth('admin')).send({ greenThreshold: 0.995 })).status).toBe(200);
    });
  });
});
