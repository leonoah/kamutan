/**
 * Stage 10 — API/Sec: export gate on red lines (FR-31, XL-06, UX §export: "אם הארגון חוסם ייצוא עם אדומים, הכפתור מושבת").
 * Org default blockExportOnRed=true: an unapproved red line blocks the export; a red line a human approved does not;
 * an override on that approved line sends it back to "נבדק" and blocks again; turning the policy off allows a draft
 * export with the warning. The same policy should hold for every way of handing quantities out (marked PDF, share link).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiErrorSchema, BoqViewSchema, ExportBoqResponseSchema } from '@kamutan/contracts';
import { writeEvidence } from './support/evidence';
import { createWorld, type World } from './support/world';

describe('Stage 10 API/Sec — export gate: unapproved vs approved red lines', () => {
  let w: World;
  const RED = 'ln_a_red_1';
  const P = () => `/api/v1/projects/${w.A.projectId}`;
  const ed = () => w.auth(w.A.uid('editor'));
  const ev: Record<string, unknown> = {};
  const exportXlsx = (body: Record<string, unknown> = {}) => w.http.post(`${P()}/boq/export`).set(ed()).send(body);

  beforeAll(async () => {
    w = await createWorld();
    w.t.boq.seedLine(w.A.orgId, w.A.projectId, { id: RED, code: '4.09', description: "נק' מאור תקרה", qty: 3, level: 'red', status: 'draft', reasons: ['קנה מידה סותר'], byFloor: { '0': 3 } });
    w.t.boq.seedLine(w.A.orgId, w.A.projectId, { id: 'ln_a_yellow', code: '4.10', description: 'שקע', qty: 1, level: 'yellow', status: 'draft' });
  });
  afterAll(async () => {
    writeEvidence('export-gate.json', ev);
    await w.t.app.close();
  });

  it('BOQ summary announces the policy; an UNAPPROVED red line → 409 export_blocked with the count (yellow lines never block)', async () => {
    const v = BoqViewSchema.parse((await w.http.get(`${P()}/boq`).set(ed())).body);
    expect(v.summary.blockExportOnRed).toBe(true);
    const r = await exportXlsx();
    expect(r.status).toBe(409);
    expect(ApiErrorSchema.parse(r.body).error).toMatchObject({ code: 'export_blocked', issues: [{ path: 'red', message: '1' }] });
    // markDraft does not bypass the policy
    expect((await exportXlsx({ markDraft: true, split: 'byFloor' })).status).toBe(409);
    ev.blocked = r.body;
  });

  it('the reviewer approves the red line (draft → reviewed → approved) → the export goes through, with warnings', async () => {
    const url = `${P()}/boq/lines/${RED}`;
    expect((await w.http.patch(url).set(w.auth(w.A.uid('reviewer'))).send({ status: 'reviewed' })).status).toBe(200);
    expect((await exportXlsx()).status).toBe(409); // "reviewed" is not enough
    expect((await w.http.patch(url).set(w.auth(w.A.uid('reviewer'))).send({ status: 'approved' })).status).toBe(200);
    const r = await exportXlsx();
    expect(r.status).toBe(200);
    expect(ExportBoqResponseSchema.parse(r.body)).toMatchObject({ hasWarnings: true });
    ev.approved = r.body;
  });

  it('an override on the approved red line sends it back to "נבדק" → blocked again', async () => {
    expect((await w.http.patch(`${P()}/boq/lines/${RED}`).set(ed()).send({ qtyOverride: 4, reason: 'ספירה ידנית' })).body.line.status).toBe('reviewed');
    expect((await exportXlsx()).status).toBe(409);
  });

  it('A-API-04: the marked-PDF export honours the same policy (unapproved red line → 409 export_blocked)', async () => {
    const r = await w.http.post(`${P()}/boq/export/marked-pdf`).set(ed()).send({});
    ev.markedPdfWithOpenRed = { status: r.status, body: r.body };
    expect(r.status).toBe(409);
  });

  it('A-API-04: a share link (frozen BOQ for the contractor) honours the same policy (unapproved red line → 409)', async () => {
    const r = await w.http.post(`${P()}/share-links`).set(ed()).send({ label: 'קבלן' });
    ev.shareWithOpenRed = { status: r.status };
    expect(r.status).toBe(409);
  });

  it('admin turns the policy off → export allowed with red lines (warning), and the change is audited', async () => {
    const s = await w.http.patch(`/api/v1/orgs/${w.A.orgId}/settings`).set(w.auth(w.A.uid('admin'))).send({ blockExportOnRed: false });
    expect(s.status).toBe(200);
    const r = await exportXlsx({ markDraft: true });
    expect(r.status).toBe(200);
    expect(r.body.hasWarnings).toBe(true);
    const audit = (await w.http.get(`/api/v1/orgs/${w.A.orgId}/audit?entity=orgs&action=update_settings`).set(w.auth(w.A.uid('admin')))).body;
    expect(audit.items[0].after).toMatchObject({ changes: { blockExportOnRed: { from: true, to: false } } });
  });

  describe('approved line whose computed quantity changed in a rebuild (worker: level red + "הכמות השתנתה מאז האישור", status kept)', () => {
    let w2: World;
    beforeAll(async () => {
      w2 = await createWorld();
      // what workers/drawing boq/build.py `_approval_check` writes after a rebuild moved an approved qty 6 → 7
      w2.t.boq.seedLine(w2.A.orgId, w2.A.projectId, { id: 'ln_a_moved', code: '4.11', description: 'גוף תאורה', qty: 7, level: 'red', status: 'approved', approvedBy: w2.A.uid('reviewer'), reasons: ['הכמות השתנתה מאז האישור'], approvedQty: 6 } as never);
    });
    afterAll(async () => {
      await w2.t.app.close();
    });
    it('A-API-06: the export is blocked until a human re-approves the changed quantity (it is not "approved" any more)', async () => {
      const r = await w2.http.post(`/api/v1/projects/${w2.A.projectId}/boq/export`).set(w2.auth(w2.A.uid('editor'))).send({});
      ev.approvedButChanged = { status: r.status, body: r.body };
      expect(r.status).toBe(409);
    });
  });
});
