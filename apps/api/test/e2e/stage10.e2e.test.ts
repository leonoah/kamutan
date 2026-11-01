/**
 * Stage 10 fix round (API): regression tests for A-API-01 (members / invites), A-API-06 audit of invalidated
 * approvals, A-UI-08 (manual add in the line history, real API path), A-UI-13 (Hebrew audit summary), A-LIVE-02
 * (project card counters), evidence targets for non-detection ids, the "פירוט לפי חדר" Excel sheet, the export gate on
 * approved-but-changed lines, and the small-level watermark period (A-API-11).
 */
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AcceptInviteResponseSchema,
  AuditPageSchema,
  BoqLineEvidenceResponseSchema,
  CreateInviteResponseSchema,
  ExportBoqResponseSchema,
  fsPaths,
  InviteListSchema,
  LineHistoryResponseSchema,
  MemberListSchema,
  MeResponseSchema,
  ProjectPageSchema,
  ProjectSchema,
  storagePaths,
} from '@kamutan/contracts';
import { ROOM_SHEET, MAIN_SHEET } from '../../src/boq/excel';
import type { Doc } from '../../src/db/mappers';
import { WATERMARK_MIN_PERIOD_PX, WATERMARK_PERIOD_PX, watermarkPeriodFor } from '../../src/share/watermark';
import { auditsOf, createWorld, type World } from '../acceptance/support/world';

describe('Stage 10 e2e (API fix round)', () => {
  let w: World;
  const P = () => `/api/v1/projects/${w.A.projectId}`;
  const O = () => `/api/v1/orgs/${w.A.orgId}`;
  const as = (r: 'viewer' | 'reviewer' | 'editor' | 'admin') => w.auth(w.A.uid(r));
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  beforeAll(async () => {
    w = await createWorld();
  });
  afterAll(async () => {
    await w.t.app.close();
  });

  describe('A-API-01 members + invites', () => {
    it('list (admin only), invite link, first sign-in claim with the VERIFIED email, role change, last admin kept, remove — all audited', async () => {
      expect((await w.http.get(`${O()}/members`).set(as('editor'))).status).toBe(403);
      const list = MemberListSchema.parse((await w.http.get(`${O()}/members`).set(as('admin'))).body);
      expect(list.items[0]?.role).toBe('admin');
      expect(list.items.find((m) => m.uid === w.A.uid('admin'))?.isSelf).toBe(true);

      // MFA + recent sign-in on mutations (SEC-02)
      const noMfa = w.t.auth.issue(w.A.uid('admin'));
      expect((await w.http.post(`${O()}/invites`).set(bearer(noMfa)).send({ email: 'x@y.test', role: 'viewer' })).body.error.code).toBe('mfa_required');
      const old = w.t.auth.issue(w.A.uid('admin'), { mfa: true, authTime: Math.floor(Date.now() / 1000) - 3600 });
      expect((await w.http.post(`${O()}/invites`).set(bearer(old)).send({ email: 'x@y.test', role: 'viewer' })).body.error.code).toBe('recent_auth_required');
      expect((await w.http.post(`${O()}/invites`).set(as('admin')).send({ email: 'not-an-email', role: 'viewer' })).status).toBe(400);

      const inv = CreateInviteResponseSchema.parse((await w.http.post(`${O()}/invites`).set(as('admin')).send({ email: '  Dana.New@Example.TEST ', role: 'reviewer' })).body);
      expect(inv.invite).toMatchObject({ email: 'dana.new@example.test', role: 'reviewer', status: 'pending', state: 'pending' });
      expect(inv.url).toBe(`https://app.example.test/invite/${inv.invite.id}`);
      // re-inviting the same email re-uses the pending invite (new role)
      const again = CreateInviteResponseSchema.parse((await w.http.post(`${O()}/invites`).set(as('admin')).send({ email: 'dana.new@example.test', role: 'editor' })).body);
      expect(again.invite.id).toBe(inv.invite.id);
      expect(InviteListSchema.parse((await w.http.get(`${O()}/invites`).set(as('admin'))).body).items.find((i) => i.id === inv.invite.id)?.role).toBe('editor');

      // an unverified email is never claimed; another user with the link gets 404
      const unverified = w.t.auth.issue('dana_new', { email: 'dana.new@example.test', emailVerified: false });
      expect(MeResponseSchema.parse((await w.http.get('/api/v1/me').set(bearer(unverified))).body).orgs).toEqual([]);
      expect((await w.http.post(`/api/v1/invites/${inv.invite.id}/accept`).set(bearer(unverified)).send({})).status).toBe(404);
      expect((await w.http.post(`/api/v1/invites/${inv.invite.id}/accept`).set(as('viewer')).send({})).status).toBe(404);

      // first sign-in with the verified email → member with the invite's role
      const dana = w.t.auth.issue('dana_new', { email: 'Dana.New@example.test', name: 'דנה חדשה' });
      const me = MeResponseSchema.parse((await w.http.get('/api/v1/me').set(bearer(dana))).body);
      expect(me.orgs.map((o) => [o.id, o.role])).toEqual([[w.A.orgId, 'editor']]);
      // the link afterwards is idempotent
      expect(AcceptInviteResponseSchema.parse((await w.http.post(`/api/v1/invites/${inv.invite.id}/accept`).set(bearer(dana)).send({})).body)).toEqual({ orgId: w.A.orgId, role: 'editor', alreadyMember: true });
      expect(w.t.repo.docs.get(fsPaths.member(w.A.orgId, 'dana_new'))).toMatchObject({ role: 'editor', email: 'dana.new@example.test', displayName: 'דנה חדשה', addedBy: w.A.uid('admin') });

      // explicit accept through the link (no prior /me)
      const inv2 = CreateInviteResponseSchema.parse((await w.http.post(`${O()}/invites`).set(as('admin')).send({ email: 'link@example.test', role: 'viewer' })).body);
      const linkUser = w.t.auth.issue('link_user', { email: 'link@example.test' });
      expect(AcceptInviteResponseSchema.parse((await w.http.post(`/api/v1/invites/${inv2.invite.id}/accept`).set(bearer(linkUser)).send({})).body)).toEqual({ orgId: w.A.orgId, role: 'viewer', alreadyMember: false });

      // a revoked invite cannot be claimed
      const inv3 = CreateInviteResponseSchema.parse((await w.http.post(`${O()}/invites`).set(as('admin')).send({ email: 'revoked@example.test', role: 'viewer' })).body);
      expect((await w.http.delete(`${O()}/invites/${inv3.invite.id}`).set(as('admin'))).body.invite.state).toBe('revoked');
      const revokedUser = w.t.auth.issue('revoked_user', { email: 'revoked@example.test' });
      expect(MeResponseSchema.parse((await w.http.get('/api/v1/me').set(bearer(revokedUser))).body).orgs).toEqual([]);

      // role change (effective immediately), last admin protected, remove
      expect((await w.http.patch(`${O()}/members/dana_new`).set(as('admin')).send({ role: 'viewer' })).body.member.role).toBe('viewer');
      expect((await w.http.post(`${P()}/boq/build`).set(bearer(dana)).send({})).status).toBe(403);
      expect((await w.http.patch(`${O()}/members/${w.A.uid('admin')}`).set(as('admin')).send({ role: 'editor' })).status).toBe(409);
      expect((await w.http.delete(`${O()}/members/${w.A.uid('admin')}`).set(as('admin'))).status).toBe(409);
      expect((await w.http.delete(`${O()}/members/dana_new`).set(as('admin'))).body).toEqual({ uid: 'dana_new', removed: true });
      expect((await w.http.get(P()).set(bearer(dana))).status).toBe(404);
      expect((await w.http.delete(`${O()}/members/dana_new`).set(as('admin'))).status).toBe(404);

      const actions = auditsOf(w.t, w.A.orgId).filter((e) => e.entity === 'members' || e.entity === 'invites').map((e) => `${e.entity}/${e.action}`);
      expect(actions).toEqual(expect.arrayContaining(['members/invite', 'invites/accept', 'invites/revoke', 'members/update_role', 'members/remove']));
      // B's admin never sees / changes A's members
      expect((await w.http.get(`${O()}/members`).set(w.auth(w.B.uid('admin')))).status).toBe(404);
      expect((await w.http.patch(`${O()}/members/${w.A.uid('viewer')}`).set(w.auth(w.B.uid('admin'))).send({ role: 'admin' })).status).toBe(404);
    });
  });

  describe('A-API-06 invalidated approvals: audit events from the build doc + history + gate', () => {
    it('one hash-chained event per approvalsInvalidated entry, once; listed in the line history', async () => {
      const { orgId, projectId } = w.A;
      w.t.boq.seedLine(orgId, projectId, { id: 'ln_a_4_30', code: '4.30', description: 'שקע', qty: 17, level: 'red', status: 'reviewed', reasons: ['הכמות השתנתה מאז האישור (16 → 17)'], approvalInvalidated: { fromQty: 16, toQty: 17, buildId: 'b9' } } as never);
      w.t.repo.docs.set(fsPaths.boqBuild(orgId, projectId, 'b9'), { status: 'succeeded', jobId: null, requestedBy: null, createdAt: new Date(), approvalsInvalidated: [{ lineId: 'ln_a_4_30', code: '4.30', fromQty: 16, toQty: 17 }, { lineId: 'bad id!', code: 'x', fromQty: 1, toQty: 2 }] });
      const pp = fsPaths.project(orgId, projectId);
      w.t.repo.docs.set(pp, { ...(w.t.repo.docs.get(pp) as Doc), boq: { latestBuildId: 'b9', builtAt: new Date(), stale: false } });
      const count = () => auditsOf(w.t, orgId).filter((e) => e.action === 'approval_invalidated').length;
      expect((await w.http.get(`${P()}/boq`).set(as('viewer'))).status).toBe(200);
      expect(count()).toBe(1);
      await w.http.get(`${P()}/boq`).set(as('viewer'));
      expect(count()).toBe(1);
      expect(w.t.repo.docs.get(fsPaths.boqBuild(orgId, projectId, 'b9'))?.approvalsAuditedAt).toBeTruthy();
      const ev = auditsOf(w.t, orgId).find((e) => e.action === 'approval_invalidated');
      expect(ev).toMatchObject({ actorId: 'system:boq.build', actorKind: 'system', entity: 'boqLines', entityId: 'ln_a_4_30', after: { projectId, buildId: 'b9', fromQty: 16, toQty: 17 } });
      expect((await w.http.get(`${O()}/audit/verify`).set(as('admin'))).body.ok).toBe(true);
      const h = LineHistoryResponseSchema.parse((await w.http.get(`${P()}/boq/lines/ln_a_4_30/history`).set(as('viewer'))).body);
      expect(h.items.map((i) => [i.action, i.before, i.after])).toEqual([
        ['status', 'approved', 'reviewed'],
        ['rebuild', 16, 17],
      ]);
      expect(h.items[0]?.reason).toBe('הכמות השתנתה מאז האישור (16 → 17)');
      w.t.repo.docs.set(pp, { ...(w.t.repo.docs.get(pp) as Doc), boq: { latestBuildId: 'b1', builtAt: new Date(), stale: false } });
      w.t.repo.docs.delete(fsPaths.boqLine(orgId, projectId, 'ln_a_4_30'));
    });

    it('legacy worker (approved kept, approvedQty ≠ qty) blocks every export; with the policy off the xlsx says "נבדק", never "אושר"', async () => {
      const { orgId, projectId } = w.A;
      w.t.boq.seedLine(orgId, projectId, { id: 'ln_a_4_31', code: '4.31', description: 'גוף', qty: 7, level: 'green', status: 'approved', approvedQty: 6 } as never);
      for (const url of [`${P()}/boq/export`, `${P()}/boq/export/marked-pdf`, `${P()}/share-links`]) {
        const r = await w.http.post(url).set(as('editor')).send(url.endsWith('share-links') ? { label: 'x' } : {});
        expect([url, r.status, r.body.error?.code]).toEqual([url, 409, 'export_blocked']);
      }
      w.t.repo.docs.set(fsPaths.org(orgId), { ...(w.t.repo.docs.get(fsPaths.org(orgId)) as Doc), settings: { ...((w.t.repo.docs.get(fsPaths.org(orgId)) as Doc).settings as Doc), blockExportOnRed: false } });
      const ex = ExportBoqResponseSchema.parse((await w.http.post(`${P()}/boq/export`).set(as('editor')).send({})).body);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(w.t.boqStorage.objects.get(storagePaths.boqExportFile(orgId, projectId, ex.exportId)) as unknown as ArrayBuffer);
      let status: unknown = null;
      (wb.getWorksheet(MAIN_SHEET) as ExcelJS.Worksheet).eachRow((row) => {
        if (row.getCell(1).value === '4.31') status = row.getCell(row.cellCount).value;
      });
      expect(status).toBe('נבדק');
      w.t.repo.docs.set(fsPaths.org(orgId), { ...(w.t.repo.docs.get(fsPaths.org(orgId)) as Doc), settings: { ...((w.t.repo.docs.get(fsPaths.org(orgId)) as Doc).settings as Doc), blockExportOnRed: true } });
      w.t.repo.docs.delete(fsPaths.boqLine(orgId, projectId, 'ln_a_4_31'));
    });
  });

  it('A-UI-08 + A-UI-13: a manual add (real API path) shows in the line history with a Hebrew summary; the audit log has readable summaries', async () => {
    const { orgId, projectId, sheet } = w.A;
    const add = await w.http.post(`${P()}/corrections`).set(as('reviewer')).send({ sheetId: sheet.sheetId, versionId: sheet.versionId, kind: 'add', class: 'socket_double', anchorMm: { x: 120, y: 90 } });
    expect(add.status).toBe(201);
    const cid = add.body.correction.id as string;
    // the worker's rebuild puts the manual item into the line's evidence (source manual + correctionId)
    w.t.boqStorage.putEvidence(storagePaths.boqEvidence(orgId, projectId, 'b1'), {
      schema: 'kamutan.boq-evidence/1',
      lines: { [w.A.lines.status]: [{ sheetId: sheet.sheetId, versionId: sheet.versionId, detectionId: 'd_1', linkGroupId: null, floor: '0' }, { sheetId: sheet.sheetId, versionId: sheet.versionId, detectionId: `m_${cid}`, linkGroupId: null, floor: '0', source: 'manual', correctionId: cid }] },
    });
    const h = LineHistoryResponseSchema.parse((await w.http.get(`${P()}/boq/lines/${w.A.lines.status}/history`).set(as('viewer'))).body);
    const item = h.items.find((i) => i.action === 'correction' && (i.after as Doc).correctionId === cid);
    expect(item).toMatchObject({ by: { uid: w.A.uid('reviewer') }, summary: 'תיקון על השרטוט · הוספת פריט ידני · שקע כפול' });
    const audit = AuditPageSchema.parse((await w.http.get(`${O()}/audit?entity=corrections&action=create`).set(as('admin'))).body);
    const row = audit.items.find((e) => e.entityId === cid);
    expect(row).toMatchObject({ entityLabel: 'תיקונים', actionLabel: 'יצירה', summary: 'תיקון על השרטוט · הוספת פריט ידני · שקע כפול' });
    expect(row?.summary).not.toMatch(/socket_double|kind:/);
  });

  it('A-LIVE-02: project cards carry sheets / levels (worker counters when written, else counted) + reviewOpen', async () => {
    const page = ProjectPageSchema.parse((await w.http.get(`/api/v1/projects?orgId=${w.A.orgId}`).set(as('viewer'))).body);
    const p = page.items.find((x) => x.id === w.A.projectId);
    expect(p?.stats).toMatchObject({ sheets: 2, boqLines: 4, green: 4, yellow: 0, red: 0, reviewOpen: 0 });
    const pp = fsPaths.project(w.A.orgId, w.A.projectId);
    w.t.repo.docs.set(pp, { ...(w.t.repo.docs.get(pp) as Doc), stats: { sheets: 3, boqLines: 52, green: 0, yellow: 50, red: 2 } });
    w.t.boq.seedLine(w.A.orgId, w.A.projectId, { id: 'ln_a_4_40', code: '4.40', level: 'yellow', status: 'draft' });
    const one = ProjectSchema.parse((await w.http.get(P()).set(as('viewer'))).body);
    expect(one.stats).toEqual({ sheets: 3, boqLines: 52, green: 0, yellow: 50, red: 2, reviewOpen: 1 });
    w.t.repo.docs.delete(fsPaths.boqLine(w.A.orgId, w.A.projectId, 'ln_a_4_40'));
  });

  it('evidence ids that are not detections get a target: whole sheet, text line (box from text.json.gz), room', async () => {
    const { orgId, projectId, sheet } = w.A;
    w.t.boq.seedLine(orgId, projectId, { id: 'ln_a_1_01', code: '1.01', chapter: '01', level: 'yellow', status: 'draft', buildId: 'b7' });
    w.t.artifacts.putJson(storagePaths.text(orgId, projectId, sheet.sheetId, sheet.versionId), { schema: 'kamutan.text/1', lines: [{ text: 'סוד', bboxMm: [10, 20, 30, 25] }, { text: 'משאבה', bboxMm: [100, 200, 140, 206] }] });
    const it_ = (detectionId: string) => ({ sheetId: sheet.sheetId, versionId: sheet.versionId, detectionId, linkGroupId: null, floor: '0' });
    w.t.boqStorage.putEvidence(storagePaths.boqEvidence(orgId, projectId, 'b7'), { schema: 'kamutan.boq-evidence/1', lines: { ln_a_1_01: [it_('sheet'), it_('text_1'), it_('text_9'), it_('r_1'), it_('d_1')] } });
    const ev = BoqLineEvidenceResponseSchema.parse((await w.http.get(`${P()}/boq/lines/ln_a_1_01/evidence`).set(as('viewer'))).body);
    expect(ev.items.map((i) => i.target)).toEqual([
      { kind: 'sheet', bboxMm: null },
      { kind: 'text', bboxMm: { x: 100, y: 200, w: 40, h: 6 } },
      { kind: 'text', bboxMm: null },
      { kind: 'room', bboxMm: null },
      { kind: 'detection', bboxMm: null },
    ]);
    expect(JSON.stringify(ev)).not.toContain('משאבה'); // the text itself never leaves the server
    w.t.repo.docs.delete(fsPaths.boqLine(orgId, projectId, 'ln_a_1_01'));
  });

  it('Excel "פירוט לפי חדר": one row per (line, room) + a SUM per line; lines without byRoom → one "—" row', async () => {
    const { orgId, projectId } = w.A;
    w.t.boq.seedLine(orgId, projectId, { id: 'ln_a_3_04', code: '3.04', chapter: '03', description: 'ניאגרה סמויה', qty: 3, level: 'green', status: 'draft', byRoom: [{ sheetId: null, roomId: 'r_1', name: 'שירותים', type: 'wc', floor: '0', qty: 1 }, { sheetId: null, roomId: 'r_2', name: 'חדר רחצה', type: 'bathroom', floor: '1', qty: 2 }] } as never);
    const ex = ExportBoqResponseSchema.parse((await w.http.post(`${P()}/boq/export`).set(as('editor')).send({})).body);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(w.t.boqStorage.objects.get(storagePaths.boqExportFile(orgId, projectId, ex.exportId)) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet(ROOM_SHEET) as ExcelJS.Worksheet;
    expect(ws.views[0]?.rightToLeft).toBe(true);
    const rows: unknown[][] = [];
    ws.eachRow((r) => rows.push([1, 2, 3, 4, 5, 6].map((c) => r.getCell(c).value)));
    const mine = rows.filter((r) => r[0] === '3.04');
    expect(mine.map((r) => [r[4], r[5]])).toEqual([
      ['שירותים', 1],
      ['חדר רחצה', 2],
    ]);
    const sum = rows.find((r) => r[1] === 'סה"כ 3.04');
    expect((sum?.[5] as { formula: string; result: number }).result).toBe(3);
    expect(rows.find((r) => r[0] === '4.01')?.[4]).toBe('—');
    w.t.repo.docs.delete(fsPaths.boqLine(orgId, projectId, 'ln_a_3_04'));
  });

  it('A-API-11: the watermark period fits small levels (overview) and stays 384 px on large ones', () => {
    expect(watermarkPeriodFor(155, 110)).toBe(WATERMARK_MIN_PERIOD_PX);
    expect(watermarkPeriodFor(620, 440)).toBe(220);
    expect(watermarkPeriodFor(9920, 7016)).toBe(WATERMARK_PERIOD_PX);
  });
});
