/**
 * Sprint 5 security gate (docs/sprints/sprint-5-security-gate.md) — regression tests built from the reviewer's PoCs.
 * F-1 (rules) lives in firebase/tests (emulator suite); everything API-side is here.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuditVerifyResponseSchema,
  CreateShareLinkResponseSchema,
  ExportStatusResponseSchema,
  fsPaths,
  LineHistoryResponseSchema,
  MarkedPdfJobSchema,
  OffboardingExportViewSchema,
  PublicShareBoqSchema,
  PublicShareMetaSchema,
  PublicShareOverlaySchema,
  storagePaths,
} from '@kamutan/contracts';
import { logPath } from '../../src/common/logging';
import { ipLimitKey } from '../../src/db/governance-docs';
import type { Doc } from '../../src/db/mappers';
import { createTestApp, type TestApp } from '../support/app';
import { testConfig } from '../support/helpers';

describe('Sprint 5 security gate regressions (F-2 … F-9)', () => {
  let t: TestApp;
  let http: ReturnType<typeof request>;
  const tok: Record<string, string> = {};
  let orgId: string;
  let projectId: string;
  let masked: { sheetId: string; versionId: string };
  let unmasked: { sheetId: string; versionId: string };
  const auth = (who: string) => ({ authorization: `Bearer ${tok[who]}` });
  const S = (token: string) => `/api/v1/public/share/${token}`;
  const link = async (body: Record<string, unknown> = {}) => {
    const r = await http.post(`/api/v1/projects/${projectId}/share-links`).set(auth('editor')).send({ label: 'קבלן', ...body });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return CreateShareLinkResponseSchema.parse(r.body);
  };

  beforeAll(async () => {
    t = await createTestApp(testConfig({ THROTTLE_LIMIT: '100000', UPLOAD_THROTTLE_LIMIT: '1000', SHARE_RATE_LIMIT_PER_MIN: '1000', SHARE_UNKNOWN_TOKEN_LIMIT: '10' }));
    http = request(t.app.getHttpServer());
    const now = Math.floor(Date.now() / 1000);
    tok.editor = t.auth.issue('editor');
    tok.reviewer = t.auth.issue('reviewer');
    tok.admin = t.auth.issue('admin', { mfa: true, authTime: now });
    tok.adminNoMfa = t.auth.issue('admin', { authTime: now });
    tok.adminStale = t.auth.issue('admin', { mfa: true, authTime: now - 3600 });
    orgId = t.repo.seedOrg('משרד', { editor: 'editor', reviewer: 'reviewer', admin: 'admin' }).id;
    projectId = (await t.repo.createProject(orgId, { name: 'בית משפחת נח', address: 'רחוב הדקל 5' }, 'editor')).id;
    masked = t.repo.seedWorkerSheet(orgId, projectId, 'setA', 0, { understanding: true, title: 'נח - חשמל', widthMm: 420, heightMm: 297, widthPx: 4961, heightPx: 3508, levels: 6 });
    unmasked = t.repo.seedWorkerSheet(orgId, projectId, 'setB', 0, { understanding: true, title: 'נח - אינסטלציה', widthMm: 420, heightMm: 297, widthPx: 4961, heightPx: 3508, levels: 6 });
    const vp = fsPaths.version(orgId, projectId, masked.sheetId, masked.versionId);
    t.repo.docs.set(vp, { ...(t.repo.docs.get(vp) as Doc), titleBlockMm: { x: 330, y: 0, w: 90, h: 297 } }); // right-hand column
    t.boq.seedLine(orgId, projectId, { id: 'ln_4_01', code: '4.01', description: 'שקע', qty: 2, level: 'yellow', status: 'draft', reasons: ['ביטחון נמוך'], qtyOverride: 3, qtyOverrideReason: 'פנימי' });
    const p = t.repo.docs.get(fsPaths.project(orgId, projectId)) as Doc;
    t.repo.docs.set(fsPaths.project(orgId, projectId), { ...p, boq: { latestBuildId: 'b1', builtAt: new Date(), stale: false } });
  });
  afterAll(async () => {
    await t.app.close();
  });

  // ---------------------------------------------------------------- F-2
  describe('F-2: client IP = trusted hop, not the client-controlled left end of X-Forwarded-For', () => {
    it('PoC: rotating the left-most XFF entries does NOT avoid the unknown-token lockout', async () => {
      const good = await link();
      // Hosting appends the real client (198.51.100.7) and the edge (10.0.0.9); the client prepends garbage.
      const xff = (i: number) => `203.0.113.${i}, 198.51.100.7, 10.0.0.9`;
      for (let i = 0; i < 10; i++) expect((await http.get(S(`${'A'.repeat(42)}${String.fromCharCode(65 + i)}`) + '/meta').set('x-forwarded-for', xff(i))).status).toBe(404);
      const locked = await http.get(S(good.token) + '/meta').set('x-forwarded-for', xff(99));
      expect(locked.status).toBe(429);
      // a different real client behind the same edge is not affected
      expect((await http.get(S(good.token) + '/meta').set('x-forwarded-for', '203.0.113.1, 198.51.100.8, 10.0.0.9')).status).toBe(200);
    });

    it('the view audit records the trusted client prefix, not a forged one; IPv6 limiter key = /64', async () => {
      const l = await link({ label: 'audit-ip' });
      await http.get(S(l.token) + '/meta').set('x-forwarded-for', '1.2.3.4, 192.0.2.77, 10.0.0.9');
      const ev = [...t.repo.docs.values()].filter((d) => d.entity === 'shareLinks' && d.action === 'view' && d.actorId === l.link.id);
      expect((ev.at(-1)?.after as Doc).ipPrefix).toBe('192.0.2.0/24');
      expect(ipLimitKey('2001:db8:aaaa:bbbb:1:2:3:4')).toBe(ipLimitKey('2001:db8:aaaa:bbbb:ffff::9'));
      expect(ipLimitKey('2001:db8:aaaa:bbbb::1')).toBe('2001:db8:aaaa:bbbb::/64');
      expect(ipLimitKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
      expect(ipLimitKey('192.0.2.5')).toBe('192.0.2.5');
    });
  });

  // ---------------------------------------------------------------- F-3
  describe('F-3: hideTitleBlock fails closed when no title block was detected', () => {
    it('sheet without a detected title block is EXCLUDED, with a per-sheet status + explicit warning', async () => {
      const r = await link({ allowPdfDownload: true });
      expect(r.link.sheets).toEqual([
        { sheetId: masked.sheetId, versionId: masked.versionId, titleBlockMasked: true, included: true },
        { sheetId: unmasked.sheetId, versionId: unmasked.versionId, titleBlockMasked: false, included: false },
      ].sort((a, b) => a.sheetId.localeCompare(b.sheetId)));
      expect(r.warnings).toEqual([expect.objectContaining({ code: 'title_block_not_detected', sheetIds: [unmasked.sheetId] })]);
      expect(r.link.versionLockBySheet).toEqual({ [masked.sheetId]: masked.versionId });
      // not reachable publicly, not in the per-link PDF job
      expect((await http.get(S(r.token) + `/sheets/${unmasked.sheetId}/overlay`)).status).toBe(404);
      expect((await http.get(S(r.token) + `/sheets/${unmasked.sheetId}/tiles/0/0/0`)).status).toBe(404);
      expect(MarkedPdfJobSchema.parse(t.queue.messages.at(-1)?.data).versionIds).toEqual({ [masked.sheetId]: masked.versionId });
      // the detected box (right-hand column), never a guessed bottom strip
      const o = PublicShareOverlaySchema.parse((await http.get(S(r.token) + `/sheets/${masked.sheetId}/overlay`)).body);
      expect(o.maskMm).toEqual({ x: 330, y: 0, w: 90, h: 297 });
    });

    it('explicit opt-in (includeUnmaskedSheets) → included, reported unmasked, no fake mask', async () => {
      const r = await link({ includeUnmaskedSheets: true });
      expect(r.link.sheets.find((s) => s.sheetId === unmasked.sheetId)).toMatchObject({ included: true, titleBlockMasked: false });
      expect(r.warnings).toEqual([expect.objectContaining({ code: 'title_block_not_detected_included', sheetIds: [unmasked.sheetId] })]);
      const m = PublicShareMetaSchema.parse((await http.get(S(r.token) + '/meta')).body);
      expect(m.sheets.map((s) => [s.sheetId, s.titleBlockMasked])).toEqual(expect.arrayContaining([[unmasked.sheetId, false], [masked.sheetId, true]]));
      expect(PublicShareOverlaySchema.parse((await http.get(S(r.token) + `/sheets/${unmasked.sheetId}/overlay`)).body).maskMm).toBeNull();
    });

    it('hideTitleBlock: no project name, no title-block sheet titles anywhere in meta / pdf file name', async () => {
      const r = await link({ allowPdfDownload: true, label: 'הצעה לקבלן' });
      const m = PublicShareMetaSchema.parse((await http.get(S(r.token) + '/meta')).body);
      expect(m.project).toEqual({ name: 'הצעה לקבלן', address: null });
      expect(m.sheets.map((s) => s.title)).toEqual(['גיליון 1']);
      expect(JSON.stringify(m)).not.toMatch(/נח|הדקל/);
      const ep = fsPaths.boqExport(orgId, projectId, r.link.pdfExportId as string);
      t.repo.docs.set(ep, { ...(t.repo.docs.get(ep) as Doc), status: 'ready', titleBlockMasked: true });
      const pdf = await http.get(S(r.token) + '/pdf').redirects(0);
      expect(pdf.status).toBe(302);
      expect(decodeURIComponent(pdf.headers.location as string)).not.toContain('נח');
    });
  });

  describe('F-3 / F-6 (Worker-Export follow-up): share PDFs are watermarked and only served when the mask is confirmed', () => {
    it('per-link PDF job always carries the watermark; title_block_not_found → meta errorCode + Hebrew message for members', async () => {
      const r = await link({ allowPdfDownload: true });
      const job = MarkedPdfJobSchema.parse(t.queue.messages.at(-1)?.data);
      expect(job.options.watermark).toMatch(/^שותף עם /);
      const ep = fsPaths.boqExport(orgId, projectId, r.link.pdfExportId as string);
      t.repo.docs.set(ep, { ...(t.repo.docs.get(ep) as Doc), status: 'failed', titleBlockMasked: false, error: { code: 'title_block_not_found', message: 'x' } });
      expect(PublicShareMetaSchema.parse((await http.get(S(r.token) + '/meta')).body).pdf).toEqual({ status: 'failed', errorCode: 'title_block_not_found' });
      expect((await http.get(S(r.token) + '/pdf')).status).toBe(409);
      const st = ExportStatusResponseSchema.parse((await http.get(`/api/v1/projects/${projectId}/exports/${r.link.pdfExportId}`).set(auth('editor'))).body);
      expect(st.export).toMatchObject({ status: 'failed', titleBlockMasked: false });
      expect(st.message).toMatch(/לא נמצאה טבלת כותרת/);
      // a ready export WITHOUT a watermark is never handed to an external viewer
      t.repo.docs.set(ep, { ...(t.repo.docs.get(ep) as Doc), status: 'ready', titleBlockMasked: true, error: null, options: { legend: true, floorSplit: false, watermark: null, hideTitleBlock: true } });
      expect((await http.get(S(r.token) + '/pdf').redirects(0)).status).toBe(404);
    });

    it('member export with omitted sheets → warning message', async () => {
      const { exportId } = (await http.post(`/api/v1/projects/${projectId}/boq/export/marked-pdf`).set(auth('editor')).send({ options: { hideTitleBlock: true } })).body as { exportId: string };
      const ep = fsPaths.boqExport(orgId, projectId, exportId);
      t.repo.docs.set(ep, { ...(t.repo.docs.get(ep) as Doc), status: 'ready', titleBlockMasked: true, titleBlockBySheet: { [masked.sheetId]: true, [unmasked.sheetId]: false } });
      const st = ExportStatusResponseSchema.parse((await http.get(`/api/v1/projects/${projectId}/exports/${exportId}`).set(auth('editor'))).body);
      expect(st.export.titleBlockBySheet).toEqual({ [masked.sheetId]: true, [unmasked.sheetId]: false });
      expect(st.message).toMatch(/הושמטו/);
    });
  });

  // ---------------------------------------------------------------- F-4
  describe('F-4: the public BOQ is frozen at link creation', () => {
    it('PoC: lines added / overridden after creation are NOT served; reasons / overridden never sent', async () => {
      const r = await link();
      t.boq.seedLine(orgId, projectId, { id: 'ln_9_99', code: '9.99', description: 'שורה חדשה אחרי יצירת הקישור', qty: 7, level: 'green', status: 'draft' });
      const lp = fsPaths.boqLine(orgId, projectId, 'ln_4_01');
      t.repo.docs.set(lp, { ...(t.repo.docs.get(lp) as Doc), qtyOverride: 40 });
      const b = await http.get(S(r.token) + '/boq');
      const body = PublicShareBoqSchema.parse(b.body);
      expect(body.lines.map((l) => [l.code, l.qty])).toEqual([['4.01', 3]]);
      expect(body.snapshotAt).toBe(r.link.createdAt);
      expect(JSON.stringify(b.body)).not.toMatch(/reasons|overridden|ביטחון נמוך|פנימי/);
      t.repo.docs.delete(fsPaths.boqLine(orgId, projectId, 'ln_9_99'));
      t.repo.docs.set(lp, { ...(t.repo.docs.get(lp) as Doc), qtyOverride: 3 });
    });

    it('a link without a snapshot (pre-gate) serves an empty BOQ, never the live lines', async () => {
      const r = await link();
      const sp = fsPaths.shareLink(orgId, projectId, r.link.id);
      t.repo.docs.set(sp, { ...(t.repo.docs.get(sp) as Doc), boqSnapshotPath: null });
      const b = PublicShareBoqSchema.parse((await http.get(S(r.token) + '/boq')).body);
      expect(b).toMatchObject({ snapshotAt: null, lines: [] });
      expect(t.govStorage.objects.has(storagePaths.shareBoqSnapshot(orgId, projectId, r.link.id))).toBe(true);
    });
  });

  // ---------------------------------------------------------------- F-5
  describe('F-5: case variants of /public', () => {
    it('PoC: /api/v1/PUBLIC/share/… is not served (canonical case only), still gets the public headers / 405, and the token is redacted in logs', async () => {
      const r = await link();
      const g = await http.get(`/api/v1/PUBLIC/share/${r.token}/meta`);
      expect(g.status).toBe(404);
      expect(g.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(g.headers['referrer-policy']).toBe('no-referrer');
      expect((await http.post(`/api/v1/Public/Share/${r.token}/meta`)).status).toBe(405);
      for (const p of [`/api/v1/PUBLIC/share/${r.token}/meta`, `/API/V1/public/SHARE/${r.token}/boq`]) expect(logPath(p)).not.toContain(r.token);
    });
  });

  // ---------------------------------------------------------------- F-7
  describe('F-7: offboarding ZIP download needs MFA + recent sign-in', () => {
    it('ready export: admin without MFA / stale sign-in → 403; status of a pending export stays readable', async () => {
      const { export: exp } = (await http.post(`/api/v1/orgs/${orgId}/offboarding/export`).set(auth('admin')).send({})).body as { export: { id: string } };
      expect(OffboardingExportViewSchema.parse((await http.get(`/api/v1/orgs/${orgId}/offboarding/export/${exp.id}`).set(auth('adminNoMfa'))).body).url).toBeNull();
      await t.gov.updateOffboardingExport(orgId, exp.id, { status: 'ready', sizeBytes: 1, sha256: 'a'.repeat(64) });
      const noMfa = await http.get(`/api/v1/orgs/${orgId}/offboarding/export/${exp.id}`).set(auth('adminNoMfa'));
      expect([noMfa.status, noMfa.body.error.code]).toEqual([403, 'mfa_required']);
      const stale = await http.get(`/api/v1/orgs/${orgId}/offboarding/export/${exp.id}`).set(auth('adminStale'));
      expect([stale.status, stale.body.error.code]).toEqual([403, 'recent_auth_required']);
      expect(OffboardingExportViewSchema.parse((await http.get(`/api/v1/orgs/${orgId}/offboarding/export/${exp.id}`).set(auth('admin'))).body).url).toContain('X-Goog-Expires=86400');
    });
  });

  // ---------------------------------------------------------------- F-8
  describe('F-8: verify detects truncation of the newest events', () => {
    it('PoC: deleting the last 2 events → ok:false, headMismatch, brokenAt = the surviving tip', async () => {
      for (let i = 0; i < 5; i++) await t.repo.appendAudit(orgId, { actorId: 'admin', entity: 'orgs', entityId: orgId, action: `evt${i}`, after: null });
      const v0 = AuditVerifyResponseSchema.parse((await http.get(`/api/v1/orgs/${orgId}/audit/verify`).set(auth('admin'))).body);
      expect(v0).toMatchObject({ ok: true, headMismatch: false });
      const keys = [...t.repo.docs.entries()].filter(([k]) => k.startsWith(`orgs/${orgId}/auditLog/`)).sort((a, b) => (a[1].at as Date).getTime() - (b[1].at as Date).getTime()).map(([k]) => k);
      const removed = keys.slice(-2).map((k) => [k, t.repo.docs.get(k)] as const);
      for (const [k] of removed) t.repo.docs.delete(k);
      const v = AuditVerifyResponseSchema.parse((await http.get(`/api/v1/orgs/${orgId}/audit/verify`).set(auth('admin'))).body);
      expect(v).toMatchObject({ ok: false, headMismatch: true, brokenAt: (keys.at(-3) as string).split('/').at(-1) });
      for (const [k, d] of removed) t.repo.docs.set(k, d as Doc);
      expect(AuditVerifyResponseSchema.parse((await http.get(`/api/v1/orgs/${orgId}/audit/verify`).set(auth('admin'))).body).ok).toBe(true);
    });
  });

  // ---------------------------------------------------------------- F-9
  describe('F-9: line history is per project', () => {
    it('PoC: an override of ln_4_01 in project B never appears in project A', async () => {
      const pB = (await t.repo.createProject(orgId, { name: 'B' }, 'editor')).id;
      t.boq.seedLine(orgId, pB, { id: 'ln_4_01', code: '4.01', description: 'x', qty: 2, level: 'yellow', status: 'draft' });
      expect((await http.patch(`/api/v1/projects/${pB}/boq/lines/ln_4_01`).set(auth('editor')).send({ qtyOverride: 99, reason: 'project-B-only reason' })).status).toBe(200);
      const a = LineHistoryResponseSchema.parse((await http.get(`/api/v1/projects/${projectId}/boq/lines/ln_4_01/history`).set(auth('reviewer'))).body);
      expect(JSON.stringify(a)).not.toContain('project-B-only reason');
      const b = LineHistoryResponseSchema.parse((await http.get(`/api/v1/projects/${pB}/boq/lines/ln_4_01/history`).set(auth('reviewer'))).body);
      expect(b.items).toEqual([expect.objectContaining({ action: 'qtyOverride', after: 99, reason: 'project-B-only reason' })]);
    });
  });
});
