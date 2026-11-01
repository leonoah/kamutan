/**
 * Stage 10 — API/Sec: E2E-12, API side — a new version of a sheet keeps the human work.
 * Human state: an approved line, an overridden line, a reviewed line, corrections on version 1. A new version is made
 * (reprocess → v2; the worker's rebuild follows the contract's `applyRebuild` reference semantics). Expected: v1 and its
 * Excel stay available, qtyOverride / approvals / statuses / corrections survive, corrections are re-applied to v2 by
 * position, and corrections that no longer match anything are reported in the review queue.
 * Worker-side matching (which detections the worker re-finds) belongs to the Pipeline tester.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyRebuild, BoqViewSchema, CorrectionPageSchema, CreateUploadResponseSchema, ExportStatusResponseSchema, FinalizeUploadResponseSchema, fsPaths, ProjectSchema, ReprocessSheetResponseSchema, SheetPageSchema, ReviewQueuePageSchema, SheetVersionSchema, storagePaths } from '@kamutan/contracts';
import type { Doc } from '../../src/db/mappers';
import { SAMPLE } from '../support/helpers';
import { det } from '../support/review-fixtures';
import { writeEvidence } from './support/evidence';
import { createWorld, type World } from './support/world';

describe('Stage 10 API/Sec — E2E-12 new sheet version keeps qtyOverride, approvals and corrections', () => {
  let w: World;
  let http: ReturnType<typeof request>;
  let v2 = '';
  let addId = '';
  let rejectId = '';
  const ev: Record<string, unknown> = {};
  const P = () => `/api/v1/projects/${w.A.projectId}`;
  const as = (r: 'editor' | 'reviewer' | 'viewer' | 'admin') => w.auth(w.A.uid(r));
  const region = { id: 'rg_1', floor: 'ground', polygonMm: [{ x: 10, y: 10 }, { x: 400, y: 10 }, { x: 400, y: 300 }, { x: 10, y: 300 }], scaleDenominator: 50 };
  const linesById = async () => Object.fromEntries(BoqViewSchema.parse((await http.get(`${P()}/boq`).set(as('viewer'))).body).items.map((l) => [l.id, l]));

  beforeAll(async () => {
    w = await createWorld();
    http = w.http;
    const L = w.A.lines;
    expect((await http.patch(`${P()}/boq/lines/${L.override}`).set(as('editor')).send({ qtyOverride: 5, reason: 'ספירה ידנית' })).status).toBe(200);
    expect((await http.patch(`${P()}/boq/lines/${L.status}`).set(as('reviewer')).send({ status: 'reviewed' })).status).toBe(200);
    expect((await http.put(`${P()}/sheets/${w.A.sheet.sheetId}/regions`).set(as('editor')).send({ regions: [region] })).status).toBe(200);
    const base = { sheetId: w.A.sheet.sheetId, versionId: w.A.sheet.versionId };
    const add = await http.post(`${P()}/corrections`).set(as('editor')).send({ ...base, kind: 'add', class: 'socket_double', anchorMm: { x: 300, y: 250 }, reason: 'שקע חסר ליד החלון' });
    const rej = await http.post(`${P()}/corrections`).set(as('reviewer')).send({ ...base, kind: 'reject', detectionId: 'd_1', anchorMm: { x: 50, y: 50 } });
    expect([add.status, rej.status]).toEqual([201, 201]);
    addId = add.body.correction.id;
    rejectId = rej.body.correction.id;
  });
  afterAll(async () => {
    writeEvidence('e2e-12-new-version.json', ev);
    await w.t.app.close();
  });

  it('a new version (reprocess): v2 queued and current, regions carried over, v1 still readable', async () => {
    const before = await linesById();
    const r = await http.post(`${P()}/sheets/${w.A.sheet.sheetId}/reprocess`).set(as('editor')).send({});
    expect(r.status).toBe(202);
    const body = ReprocessSheetResponseSchema.parse(r.body);
    v2 = body.sheetVersion.id;
    expect(body.sheet.currentVersionId).toBe(v2);
    expect(v2).not.toBe(w.A.sheet.versionId);
    expect(body.sheetVersion).toMatchObject({ status: 'queued', versionNo: 2 });
    expect(body.sheetVersion.regions).toEqual([region]);
    const v1 = SheetVersionSchema.parse((await http.get(`${P()}/sheets/${w.A.sheet.sheetId}/versions/${w.A.sheet.versionId}`).set(as('viewer'))).body);
    expect(v1.status).toBe('ready');
    expect((await http.get(`${P()}/sheets/${w.A.sheet.sheetId}/versions/${w.A.sheet.versionId}/overlay`).set(as('viewer'))).status).toBe(200);
    // the API never recomputes lines: the human state is untouched by the reprocess request itself
    expect(await linesById()).toEqual(before);
  });

  it('after the worker\'s rebuild (contract applyRebuild): qtyOverride, approvals, statuses, notes survive; corrections stay listed', async () => {
    // worker: v2 ready — d_1 re-found 1 mm away under a new id, plus a new yellow detection; the "add" no longer matches
    const { orgId, projectId, sheet } = w.A;
    const vp1 = fsPaths.version(orgId, projectId, sheet.sheetId, sheet.versionId);
    const vp2 = fsPaths.version(orgId, projectId, sheet.sheetId, v2);
    const v1doc = w.t.repo.docs.get(vp1) as Doc;
    w.t.repo.docs.set(vp2, { ...(w.t.repo.docs.get(vp2) as Doc), status: 'ready', progress: { stage: 'done', pct: 100 }, page: v1doc.page, stats: v1doc.stats, artifacts: { ...(v1doc.artifacts as Doc), detections: storagePaths.detections(orgId, projectId, sheet.sheetId, v2), rooms: storagePaths.rooms(orgId, projectId, sheet.sheetId, v2) } });
    w.t.artifacts.putJson(storagePaths.detections(orgId, projectId, sheet.sheetId, v2), { schema: 'kamutan.detections/1', detections: [det('d_9', 'socket_double', 51, 50, 0.7, 'yellow'), det('d_10', 'socket_double', 200, 200, 0.6, 'yellow')], unknownClusters: [] });
    w.t.artifacts.putJson(storagePaths.rooms(orgId, projectId, sheet.sheetId, v2), { schema: 'kamutan.rooms/1', rooms: [] });
    const ev2 = (d: string) => ({ sheetId: sheet.sheetId, versionId: v2, detectionId: d, linkGroupId: null, floor: '0' });
    w.t.boqStorage.putEvidence(storagePaths.boqEvidence(orgId, projectId, 'b2'), {
      schema: 'kamutan.boq-evidence/1',
      lines: { [w.A.lines.status]: [ev2('d_9'), ev2('d_10')] },
      corrections: { applied: [rejectId], unmatched: [{ correctionId: addId, sheetId: sheet.sheetId, versionId: sheet.versionId, reason: 'לא נמצא פריט תואם בגרסה החדשה' }] },
    });
    const before = await linesById();
    // rebuild: new computed quantities for every line; preserved fields per the contract
    for (const [id, l] of Object.entries(before)) {
      const path = fsPaths.boqLine(orgId, projectId, id);
      const existing = w.t.repo.docs.get(path) as Doc;
      const computed = { ...existing, qty: (l.qty as number) + 1, buildId: 'b2', updatedAt: new Date() };
      for (const f of ['status', 'qtyOverride', 'qtyOverrideReason', 'qtyOverrideBy', 'qtyOverrideAt', 'approvedBy', 'approvedAt', 'reviewedBy', 'reviewedAt', 'note']) delete (computed as Doc)[f];
      w.t.repo.docs.set(path, applyRebuild(existing, computed));
    }
    const pp = fsPaths.project(orgId, projectId);
    w.t.repo.docs.set(pp, { ...(w.t.repo.docs.get(pp) as Doc), boq: { latestBuildId: 'b2', builtAt: new Date(), stale: false } });

    const after = await linesById();
    const L = w.A.lines;
    expect(after[L.override]).toMatchObject({ qty: 5, qtyOverride: 5, qtyOverrideReason: 'ספירה ידנית', status: 'draft' });
    // Stage 10 decision (A-API-06 / A-pipeline-08): the approved qty 6 changed to 7 → back to "נבדק", re-approval needed
    expect(after[L.approved]).toMatchObject({ qty: 7, status: 'reviewed', approvedBy: null });
    expect(after[L.approved]?.reasons?.[0]).toBe('הכמות השתנתה מאז האישור (6 → 7)');
    expect(after[L.status]).toMatchObject({ qty: 3, status: 'reviewed', reviewedBy: w.A.uid('reviewer') });
    const corr = CorrectionPageSchema.parse((await http.get(`${P()}/corrections`).set(as('viewer'))).body);
    expect(corr.items.map((c) => c.id)).toEqual(expect.arrayContaining([addId, rejectId]));
    ev.linesAfterRebuild = after;
  });

  it('review queue: the unmatched correction is reported (red, "redo"), the moved detection is matched by position, the new one is queued', async () => {
    const q = ReviewQueuePageSchema.parse((await http.get(`${P()}/review-queue?limit=200`).set(as('viewer'))).body);
    ev.queue = q.items.map((i) => ({ kind: i.kind, id: i.id, level: i.level, reasons: i.reasons, detectionIds: i.detectionIds, ref: i.ref }));
    const unmatched = q.items.find((i) => i.kind === 'unmatched_correction');
    expect(unmatched).toMatchObject({ level: 'red', suggestedAction: 'redo_correction', ref: { correctionId: addId }, reasons: ['לא נמצא פריט תואם בגרסה החדשה'] });
    const dets = q.items.filter((i) => i.kind === 'detection' || i.kind === 'cluster').flatMap((i) => i.detectionIds);
    expect(dets).toContain('d_10');
    expect(dets).not.toContain('d_9'); // the v1 "reject" (50,50) covers d_9 at (51,50) on v2
    // reverting the unmatched correction removes it from the queue
    expect((await http.post(`${P()}/corrections/${addId}/revert`).set(as('editor')).send({})).status).toBe(200);
    const q2 = ReviewQueuePageSchema.parse((await http.get(`${P()}/review-queue?limit=200`).set(as('viewer'))).body);
    expect(q2.items.some((i) => i.kind === 'unmatched_correction')).toBe(false);
  });

  it('the Excel of the previous state stays available (signed URL)', async () => {
    const r = ExportStatusResponseSchema.parse((await http.get(`${P()}/exports/${w.A.exportId}`).set(as('viewer'))).body);
    expect(r.export.status).toBe('ready');
    expect(r.url).toContain(storagePaths.boqExportFile(w.A.orgId, w.A.projectId, w.A.exportId).split('/').slice(-1)[0]);
  });

  it('A-API-05: a revised upload (replacesSheetSetId) supersedes the old set: old sheets become old versions of the matching new sheets, counted once', async () => {
    const oldSetId = w.A.sheet.sheetId.replace(/-p0$/, '');
    const pp = fsPaths.project(w.A.orgId, w.A.projectId);
    const up = CreateUploadResponseSchema.parse((await http.post(`${P()}/uploads`).set(as('editor')).send({ filename: 'חשמל-גרסה-ב.pdf', sizeBytes: SAMPLE.pdf.length + 10 })).body);
    w.t.storage.objects.set(up.storagePath, { data: Buffer.concat([SAMPLE.pdf, Buffer.from('% rev B\n')]), contentType: 'application/pdf' });
    const res = await http.post(`${P()}/sheet-sets`).set(as('editor')).send({ uploadToken: up.uploadToken, replacesSheetSetId: oldSetId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const fin = FinalizeUploadResponseSchema.parse(res.body);
    const newSetId = fin.sheetSet.id;
    expect(w.t.repo.docs.get(fsPaths.sheetSet(w.A.orgId, w.A.projectId, newSetId))).toMatchObject({ replacesSheetSetId: oldSetId, supersede: { status: 'pending' } });
    expect(w.t.repo.docs.get(fsPaths.sheetSet(w.A.orgId, w.A.projectId, oldSetId))).toMatchObject({ supersededBySetId: newSetId });
    // while the revision is processing the old sheet stays current
    const listed = async (q = '') => SheetPageSchema.parse((await http.get(`${P()}/sheets${q}`).set(as('viewer'))).body).items;
    expect((await listed()).map((x) => x.id)).toContain(w.A.sheet.sheetId);
    // the worker splits + processes the revision (same title / discipline / floors as the old sheet)
    const oldSheet = w.t.repo.docs.get(fsPaths.sheet(w.A.orgId, w.A.projectId, w.A.sheet.sheetId)) as Doc;
    const ids = w.t.repo.seedWorkerSheet(w.A.orgId, w.A.projectId, newSetId, 0, { understanding: true });
    const np = fsPaths.sheet(w.A.orgId, w.A.projectId, ids.sheetId);
    w.t.repo.docs.set(np, { ...(w.t.repo.docs.get(np) as Doc), title: oldSheet.title ?? 'ת. חשמל', discipline: oldSheet.discipline ?? 'electrical', floors: oldSheet.floors ?? [] });
    const sp = fsPaths.sheetSet(w.A.orgId, w.A.projectId, newSetId);
    w.t.repo.docs.set(sp, { ...(w.t.repo.docs.get(sp) as Doc), status: 'ready', pageCount: 1 });
    // next read: the old sheet is superseded by the new one; lists / counts use only current sheets
    const now = (await listed()).map((x) => x.id);
    expect(now).toContain(ids.sheetId);
    expect(now).not.toContain(w.A.sheet.sheetId);
    const all = await listed('?includeSuperseded=true');
    expect(all.find((x) => x.id === w.A.sheet.sheetId)).toMatchObject({ superseded: true, supersededBy: ids.sheetId, supersededBySetId: newSetId, supersededMatch: 'title' });
    expect(all.find((x) => x.id === ids.sheetId)).toMatchObject({ supersedes: w.A.sheet.sheetId });
    expect((w.t.repo.docs.get(pp) as Doc).boq).toMatchObject({ stale: true, staleReason: 'sheet' });
    const project = ProjectSchema.parse((await http.get(P()).set(as('viewer'))).body);
    expect(project.stats?.sheets).toBe(2); // sheet2 + the revision (the old version is not counted twice)
    // the corrections on the old sheet stay listed (the worker re-matches them onto the new sheet, as in E2E-12)
    expect(CorrectionPageSchema.parse((await http.get(`${P()}/corrections`).set(as('viewer'))).body).items.some((c) => c.sheetId === w.A.sheet.sheetId)).toBe(true);
    ev.supersede = { oldSetId, newSetId, sheets: all.map((x) => ({ id: x.id, superseded: x.superseded, supersededBy: x.supersededBy, supersedes: x.supersedes })) };
    // a set can be replaced only once; an unknown set → 404
    const up2 = CreateUploadResponseSchema.parse((await http.post(`${P()}/uploads`).set(as('editor')).send({ filename: 'x.pdf', sizeBytes: SAMPLE.pdf.length + 10 })).body);
    w.t.storage.objects.set(up2.storagePath, { data: Buffer.concat([SAMPLE.pdf, Buffer.from('% rev C\n')]), contentType: 'application/pdf' });
    expect((await http.post(`${P()}/sheet-sets`).set(as('editor')).send({ uploadToken: up2.uploadToken, replacesSheetSetId: oldSetId })).status).toBe(409);
    const up3 = CreateUploadResponseSchema.parse((await http.post(`${P()}/uploads`).set(as('editor')).send({ filename: 'y.pdf', sizeBytes: 100 })).body);
    expect((await http.post(`${P()}/sheet-sets`).set(as('editor')).send({ uploadToken: up3.uploadToken, replacesSheetSetId: 'f'.repeat(64) })).status).toBe(404);
  });
});
