/**
 * Stage 10 — API/Sec: E2E-11 statuses + history + org audit (FR-26, AU-01..03, SEC-35).
 * Given an approved line, an editor overrides the quantity → the line goes to "נבדק" (reviewed; documented deviation
 * in 07_test_plan), the line history shows before/after with uid / displayName / time, the admin sees the event in
 * the org audit, the hash chain verifies — and stops verifying after tampering / deletion / a forged insert.
 */
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditPageSchema, AuditVerifyResponseSchema, BOQ_STATUS_HE, ExportBoqResponseSchema, fsPaths, LineHistoryResponseSchema, PatchBoqLineResponseSchema, storagePaths } from '@kamutan/contracts';
import { MAIN_SHEET } from '../../src/boq/excel';
import type { Doc } from '../../src/db/mappers';
import { writeEvidence } from './support/evidence';
import { auditsOf, createWorld, type World } from './support/world';

describe('Stage 10 API/Sec — E2E-11 override on an approved line, history, org audit, chain verify', () => {
  let w: World;
  let url: string;
  let t0: number;
  const ev: Record<string, unknown> = {};
  const verify = async () => AuditVerifyResponseSchema.parse((await w.http.get(`/api/v1/orgs/${w.A.orgId}/audit/verify`).set(w.auth(w.A.uid('admin')))).body);

  beforeAll(async () => {
    w = await createWorld();
    url = `/api/v1/projects/${w.A.projectId}/boq/lines/${w.A.lines.status}`;
    // Given: the line is "אושר" (draft → reviewed → approved by the reviewer, through the API)
    expect((await w.http.patch(url).set(w.auth(w.A.uid('reviewer'))).send({ status: 'reviewed' })).status).toBe(200);
    const ap = PatchBoqLineResponseSchema.parse((await w.http.patch(url).set(w.auth(w.A.uid('reviewer'))).send({ status: 'approved' })).body);
    expect(ap.line).toMatchObject({ status: 'approved', approvedBy: w.A.uid('reviewer') });
    t0 = Date.now();
  });
  afterAll(async () => {
    writeEvidence('e2e-11-history.json', ev);
    await w.t.app.close();
  });

  it('approved line: a note alone is refused (409), the editor\'s quantity override moves it to "נבדק" and clears the approval', async () => {
    expect((await w.http.patch(url).set(w.auth(w.A.uid('reviewer'))).send({ note: 'x' })).status).toBe(409);
    expect((await w.http.patch(url).set(w.auth(w.A.uid('reviewer'))).send({ qtyOverride: 3, reason: 'x' })).status).toBe(403);
    const r = await w.http.patch(url).set(w.auth(w.A.uid('editor'))).send({ qtyOverride: 3, reason: 'שקע נוסף במחסן לפי שיחה עם הלקוח' });
    expect(r.status).toBe(200);
    const { line } = PatchBoqLineResponseSchema.parse(r.body);
    expect(line).toMatchObject({ status: 'reviewed', qty: 2, qtyOverride: 3, qtyOverrideBy: w.A.uid('editor'), approvedBy: null, approvedAt: null });
    expect(BOQ_STATUS_HE[line.status]).toBe('נבדק');
    ev.line = line;
  });

  it('history: newest first, qtyOverride before/after + reason, status approved→reviewed, uid + displayName + time', async () => {
    const r = await w.http.get(`${url}/history`).set(w.auth(w.A.uid('reviewer')));
    expect(r.status).toBe(200);
    const h = LineHistoryResponseSchema.parse(r.body);
    ev.history = h;
    const ats = h.items.map((i) => i.at);
    expect([...ats].sort().reverse()).toEqual(ats);
    const ov = h.items.find((i) => i.action === 'qtyOverride');
    expect(ov).toMatchObject({ after: 3, reason: 'שקע נוסף במחסן לפי שיחה עם הלקוח', by: { uid: w.A.uid('editor'), displayName: 'editor A' } });
    expect(Date.parse(ov?.at as string)).toBeGreaterThanOrEqual(t0 - 1000);
    expect(Date.parse(ov?.at as string)).toBeLessThanOrEqual(Date.now() + 1000); // the in-memory clock is strictly increasing (+1 ms per event) and can run a few ms ahead
    const statuses = h.items.filter((i) => i.action === 'status').map((i) => [i.before, i.after, i.by?.uid]);
    expect(statuses).toEqual([
      ['approved', 'reviewed', w.A.uid('editor')],
      ['reviewed', 'approved', w.A.uid('reviewer')],
      ['draft', 'reviewed', w.A.uid('reviewer')],
    ]);
  });

  it('A-API-08: the override history item shows the quantity BEFORE the change (2, the computed qty), not null', async () => {
    const h = LineHistoryResponseSchema.parse((await w.http.get(`${url}/history`).set(w.auth(w.A.uid('reviewer')))).body);
    expect(h.items.find((i) => i.action === 'qtyOverride')?.before).toBe(2);
  });

  it('org audit: the admin sees the event (actor name, from/to, qty before/after, reason; no note text)', async () => {
    const page = AuditPageSchema.parse((await w.http.get(`/api/v1/orgs/${w.A.orgId}/audit?entity=boqLines&entityId=${w.A.lines.status}`).set(w.auth(w.A.uid('admin')))).body);
    ev.audit = page;
    const e = page.items[0];
    expect(e).toMatchObject({ entity: 'boqLines', action: 'update', entityId: w.A.lines.status, actorId: w.A.uid('editor'), actorKind: 'user', actorName: 'editor A' });
    expect(e?.after).toMatchObject({ projectId: w.A.projectId, from: 'approved', to: 'reviewed', qty: 2, prevQtyOverride: null, qtyOverride: 3, reason: 'שקע נוסף במחסן לפי שיחה עם הלקוח' });
    expect(page.items.map((i) => (i.after as Doc).to)).toEqual(['reviewed', 'approved', 'reviewed']);
    for (const who of ['editor', 'reviewer', 'viewer'] as const) expect((await w.http.get(`/api/v1/orgs/${w.A.orgId}/audit`).set(w.auth(w.A.uid(who)))).status).toBe(403);
  });

  it('the export after the change still marks the line as not approved ("נבדק" in the status column)', async () => {
    const r = ExportBoqResponseSchema.parse((await w.http.post(`/api/v1/projects/${w.A.projectId}/boq/export`).set(w.auth(w.A.uid('editor'))).send({})).body);
    const buf = w.t.boqStorage.objects.get(storagePaths.boqExportFile(w.A.orgId, w.A.projectId, r.exportId)) as Buffer;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const rows: string[][] = [];
    wb.getWorksheet(MAIN_SHEET)?.eachRow((row) => rows.push((row.values as unknown[]).map((v) => String(v ?? ''))));
    const row = rows.find((cells) => cells.includes('4.01'));
    expect(row).toBeDefined();
    expect(row).toContain('נבדק');
    expect(row).toContain('3');
  });

  it('chain verify: ok → tampered record fails at that record → deleted record fails → forged insert fails → restored ok', async () => {
    const v0 = await verify();
    expect(v0).toMatchObject({ ok: true, brokenAt: null });
    const events = auditsOf(w.t, w.A.orgId);
    const target = events.find((e) => e.entity === 'boqLines' && (e.after as Doc).qtyOverride === 3) as Doc & { id: string };
    const path = fsPaths.auditEvent(w.A.orgId, target.id);
    const orig = w.t.repo.docs.get(path) as Doc;
    // 1) tamper: someone with DB access lowers the override
    w.t.repo.docs.set(path, { ...orig, after: { ...(orig.after as Doc), qtyOverride: 2 } });
    const v1 = await verify();
    expect(v1).toMatchObject({ ok: false, brokenAt: target.id });
    w.t.repo.docs.set(path, orig);
    expect((await verify()).ok).toBe(true);
    // 2) delete a record in the middle
    const mid = events[Math.floor(events.length / 2)] as Doc & { id: string };
    const mp = fsPaths.auditEvent(w.A.orgId, mid.id);
    const midDoc = w.t.repo.docs.get(mp) as Doc;
    w.t.repo.docs.delete(mp);
    const v2 = await verify();
    expect(v2.ok).toBe(false);
    w.t.repo.docs.set(mp, midDoc);
    // 3) forged insert with a plausible hash
    const fp = fsPaths.auditEvent(w.A.orgId, 'forged0000000000000');
    w.t.repo.docs.set(fp, { ...orig, at: new Date((orig.at as Date).getTime() + 1), hash: 'f'.repeat(64) });
    const v3 = await verify();
    expect(v3.ok).toBe(false);
    w.t.repo.docs.delete(fp);
    expect((await verify()).ok).toBe(true);
    ev.verify = { v0, v1, v2, v3 };
  });

  it('AU-02: the API offers no way to update or delete audit events (append-only)', async () => {
    const e = auditsOf(w.t, w.A.orgId).at(-1) as Doc & { id: string };
    for (const m of ['patch', 'put', 'delete'] as const) {
      const r = await w.http[m](`/api/v1/orgs/${w.A.orgId}/audit/${e.id}`).set(w.auth(w.A.uid('admin'))).send({});
      expect(r.status, m).toBe(404);
    }
    expect((await w.http.delete(`/api/v1/orgs/${w.A.orgId}/audit`).set(w.auth(w.A.uid('admin')))).status).toBe(404);
  });
});
