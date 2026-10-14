import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ApiErrorSchema,
  BoqBuildJobSchema,
  CorrectionPageSchema,
  CreateCorrectionBatchResponseSchema,
  CreateCorrectionResponseSchema,
  CreateSimilarSearchResponseSchema,
  FindSimilarJobSchema,
  fsPaths,
  ReviewQueuePageSchema,
  RevertCorrectionBatchResponseSchema,
  RevertCorrectionResponseSchema,
  RoomSettingsResponseSchema,
  SimilarSearchViewSchema,
  storagePaths,
} from '@kamutan/contracts';
import type { Doc } from '../../src/db/mappers';
import { REVIEW_REPOSITORY } from '../../src/db/review-repository';
import type { InMemoryReviewRepository } from '../../src/db/review-memory.repository';
import { ReviewQueueService } from '../../src/review/review-queue.service';
import { createTestApp, type TestApp } from '../support/app';
import { testConfig } from '../support/helpers';
import { bathroom, det, seedSheet } from '../support/review-fixtures';

describe('Sprint 4 e2e — corrections, review queue, room settings, find-similar (fake auth, in-memory)', () => {
  let t: TestApp;
  let http: ReturnType<typeof request>;
  let review: InMemoryReviewRepository;
  const tok: Record<string, string> = {};
  let orgId: string;
  let otherOrg: string;
  let projectId: string;
  let otherProject: string;
  let sheet: { sheetId: string; versionId: string };
  let otherSheet: { sheetId: string; versionId: string };
  const auth = (who: string) => ({ authorization: `Bearer ${tok[who]}` });
  const P = (p = projectId) => `/api/v1/projects/${p}`;
  const audits = (o = orgId) =>
    [...t.repo.docs.entries()]
      .filter(([k]) => k.startsWith(`orgs/${o}/auditLog/`))
      .map(([, v]) => v)
      .sort((a, b) => (a.at as Date).getTime() - (b.at as Date).getTime());
  const projectBoq = (o = orgId, p = projectId) => ((t.repo.docs.get(fsPaths.project(o, p)) as Doc).boq ?? {}) as Doc;
  const accept = (detectionId = 'd_1', s = sheet) => ({ kind: 'accept', sheetId: s.sheetId, versionId: s.versionId, anchorMm: { x: 50, y: 50 }, detectionId });
  const add = (s = sheet) => ({ kind: 'add', sheetId: s.sheetId, versionId: s.versionId, anchorMm: { x: 60, y: 60 }, class: 'socket_double', reason: 'שקע חסר ליד הדלת' });
  /** Makes the project's pending build terminal (what the worker does at the end). */
  const finishPending = (o = orgId, p = projectId) => {
    const boq = projectBoq(o, p);
    for (const id of [boq.pendingBuildId, boq.autoBuildId]) {
      if (typeof id !== 'string') continue;
      const path = fsPaths.boqBuild(o, p, id);
      t.repo.docs.set(path, { ...(t.repo.docs.get(path) as Doc), status: 'succeeded' });
    }
  };

  beforeAll(async () => {
    t = await createTestApp(testConfig({ THROTTLE_LIMIT: '5000', UPLOAD_THROTTLE_LIMIT: '200' }));
    http = request(t.app.getHttpServer());
    review = t.app.get(REVIEW_REPOSITORY);
    for (const who of ['admin', 'editor', 'reviewer', 'viewer', 'outsider']) tok[who] = t.auth.issue(who);
    orgId = t.repo.seedOrg('Org', { admin: 'admin', editor: 'editor', reviewer: 'reviewer', viewer: 'viewer' }).id;
    otherOrg = t.repo.seedOrg('Other', { outsider: 'admin' }).id;
    projectId = (await t.repo.createProject(orgId, { name: 'בית משפחת נח' }, 'editor')).id;
    otherProject = (await t.repo.createProject(otherOrg, { name: 'Q' }, 'outsider')).id;
    sheet = seedSheet(t, orgId, projectId, 'setA', { detections: [det('d_1', 'socket_double', 50, 50, 0.7, 'yellow')], rooms: [bathroom()] });
    otherSheet = seedSheet(t, otherOrg, otherProject, 'setB', { detections: [det('d_1', 'socket_double', 50, 50, 0.7, 'yellow')], rooms: [bathroom()] });
  });
  afterAll(async () => {
    await t.app.close();
  });

  // ---------------------------------------------------------------- corrections
  describe('corrections lifecycle', () => {
    it('reviewer accept → 201, stored doc, audit without reason text, BOQ stale + ONE debounced build', async () => {
      const before = t.queue.messages.length;
      const r = await http.post(`${P()}/corrections`).set(auth('reviewer')).send({ ...accept(), reason: 'נבדק בשטח' });
      expect(r.status).toBe(201);
      const body = CreateCorrectionResponseSchema.parse(r.body);
      expect(body.correction).toMatchObject({ kind: 'accept', detectionId: 'd_1', by: 'reviewer', radiusMm: 3, batchId: null, revertedAt: null, reason: 'נבדק בשטח' });
      expect(body.rebuild).toMatchObject({ stale: true, autoRebuild: 'scheduled' });
      expect(t.repo.docs.has(fsPaths.correction(orgId, projectId, body.correction.id))).toBe(true);
      const ev = audits().at(-2);
      expect(ev).toMatchObject({ entity: 'corrections', action: 'create', entityId: body.correction.id, actorId: 'reviewer' });
      expect(JSON.stringify(ev?.after)).not.toContain('נבדק');
      expect((ev?.after as Doc).hasReason).toBe(true);
      expect(audits().at(-1)).toMatchObject({ entity: 'boqBuilds', action: 'request' });
      expect(projectBoq()).toMatchObject({ stale: true, staleReason: 'correction', pendingBuildId: body.rebuild.buildId });
      const build = t.repo.docs.get(fsPaths.boqBuild(orgId, projectId, body.rebuild.buildId as string)) as Doc;
      expect(build).toMatchObject({ status: 'queued', trigger: 'auto', afterBuildId: null });
      expect((build.debounceUntil as Date).getTime()).toBeGreaterThan(Date.now());
      expect(t.queue.messages.length).toBe(before + 1);
      expect(BoqBuildJobSchema.parse(t.queue.messages.at(-1)?.data)).toMatchObject({ orgId, projectId, buildId: body.rebuild.buildId });
    });

    it('further edits only push debounceUntil back (no double builds, no new message)', async () => {
      const before = t.queue.messages.length;
      const buildId = projectBoq().pendingBuildId as string;
      const until0 = ((t.repo.docs.get(fsPaths.boqBuild(orgId, projectId, buildId)) as Doc).debounceUntil as Date).getTime();
      await new Promise((r) => setTimeout(r, 5));
      for (let i = 0; i < 5; i++) {
        const r = await http.post(`${P()}/corrections`).set(auth('editor')).send(add());
        expect(CreateCorrectionResponseSchema.parse(r.body).rebuild).toMatchObject({ autoRebuild: 'debounced', buildId });
      }
      expect(t.queue.messages.length).toBe(before);
      const until1 = ((t.repo.docs.get(fsPaths.boqBuild(orgId, projectId, buildId)) as Doc).debounceUntil as Date).getTime();
      expect(until1).toBeGreaterThan(until0);
      expect([...t.repo.docs.keys()].filter((k) => k.startsWith(`orgs/${orgId}/projects/${projectId}/boqBuilds/`))).toHaveLength(1);
    });

    it('while a build is RUNNING → exactly one follow-up build after it', async () => {
      const running = projectBoq().pendingBuildId as string;
      const path = fsPaths.boqBuild(orgId, projectId, running);
      t.repo.docs.set(path, { ...(t.repo.docs.get(path) as Doc), status: 'running' });
      const a = CreateCorrectionResponseSchema.parse((await http.post(`${P()}/corrections`).set(auth('editor')).send(add())).body);
      expect(a.rebuild.autoRebuild).toBe('followup');
      expect(t.repo.docs.get(fsPaths.boqBuild(orgId, projectId, a.rebuild.buildId as string))).toMatchObject({ afterBuildId: running, status: 'queued' });
      const b = CreateCorrectionResponseSchema.parse((await http.post(`${P()}/corrections`).set(auth('editor')).send(add())).body);
      expect(b.rebuild).toMatchObject({ autoRebuild: 'debounced', buildId: a.rebuild.buildId });
      // the worker finishing the running build and clearing pendingBuildId does not open the door to a third build
      t.repo.docs.set(path, { ...(t.repo.docs.get(path) as Doc), status: 'succeeded' });
      const p = t.repo.docs.get(fsPaths.project(orgId, projectId)) as Doc;
      t.repo.docs.set(fsPaths.project(orgId, projectId), { ...p, boq: { ...(p.boq as Doc), pendingBuildId: null } });
      const c = CreateCorrectionResponseSchema.parse((await http.post(`${P()}/corrections`).set(auth('editor')).send(add())).body);
      expect(c.rebuild).toMatchObject({ autoRebuild: 'debounced', buildId: a.rebuild.buildId });
      finishPending();
    });

    it('org autoRebuild=false → stale only; publish failure → correction kept, rebuild "failed"', async () => {
      const o = t.repo.docs.get(fsPaths.org(orgId)) as Doc;
      t.repo.docs.set(fsPaths.org(orgId), { ...o, settings: { ...(o.settings as Doc), autoRebuild: false } });
      const before = t.queue.messages.length;
      const off = CreateCorrectionResponseSchema.parse((await http.post(`${P()}/corrections`).set(auth('editor')).send(add())).body);
      expect(off.rebuild).toMatchObject({ stale: true, autoRebuild: 'off', buildId: null });
      expect(t.queue.messages.length).toBe(before);
      t.repo.docs.set(fsPaths.org(orgId), o);
      const spy = vi.spyOn(t.queue, 'publish').mockRejectedValueOnce(new Error('pubsub down'));
      const r = await http.post(`${P()}/corrections`).set(auth('editor')).send(add());
      spy.mockRestore();
      expect(r.status).toBe(201);
      const body = CreateCorrectionResponseSchema.parse(r.body);
      expect(body.rebuild.autoRebuild).toBe('failed');
      expect(t.repo.docs.get(fsPaths.boqBuild(orgId, projectId, body.rebuild.buildId as string))).toMatchObject({ status: 'failed' });
      expect(projectBoq().pendingBuildId).toBeNull();
      expect(t.repo.docs.has(fsPaths.correction(orgId, projectId, body.correction.id))).toBe(true);
      finishPending();
    });

    it('revert → revertedAt + audit; twice → 409; list hides reverted unless asked', async () => {
      const c = CreateCorrectionResponseSchema.parse((await http.post(`${P()}/corrections`).set(auth('reviewer')).send(accept('d_9'))).body).correction;
      const r = await http.post(`${P()}/corrections/${c.id}/revert`).set(auth('reviewer'));
      expect(r.status).toBe(200);
      const body = RevertCorrectionResponseSchema.parse(r.body);
      expect(body.correction).toMatchObject({ id: c.id, revertedBy: 'reviewer' });
      expect(body.correction.revertedAt).not.toBeNull();
      expect(audits().some((a) => a.entity === 'corrections' && a.action === 'revert' && a.entityId === c.id)).toBe(true);
      const again = await http.post(`${P()}/corrections/${c.id}/revert`).set(auth('reviewer'));
      expect(again.status).toBe(409);
      const list = CorrectionPageSchema.parse((await http.get(`${P()}/corrections`).query({ sheetId: sheet.sheetId, limit: 500 }).set(auth('viewer'))).body);
      expect(list.items.some((x) => x.id === c.id)).toBe(false);
      const all = CorrectionPageSchema.parse((await http.get(`${P()}/corrections`).query({ sheetId: sheet.sheetId, includeReverted: 'true', limit: 500 }).set(auth('viewer'))).body);
      expect(all.items[0]?.id).toBe(c.id); // newest first
      expect(all.items.length).toBe(list.items.length + 1);
      const page1 = CorrectionPageSchema.parse((await http.get(`${P()}/corrections`).query({ limit: 2 }).set(auth('viewer'))).body);
      expect(page1.items).toHaveLength(2);
      const page2 = CorrectionPageSchema.parse((await http.get(`${P()}/corrections`).query({ limit: 2, cursor: page1.nextCursor }).set(auth('viewer'))).body);
      expect(page2.items[0]?.id).not.toBe(page1.items[1]?.id);
      const kind = CorrectionPageSchema.parse((await http.get(`${P()}/corrections`).query({ kind: 'add' }).set(auth('viewer'))).body);
      expect(kind.items.every((x) => x.kind === 'add')).toBe(true);
      finishPending();
    });

    it('validation: unknown version 404, not-ready 409, outside the page 400, per-kind rules + strict body 400', async () => {
      expect((await http.post(`${P()}/corrections`).set(auth('editor')).send({ ...add(), versionId: 'nope' })).status).toBe(404);
      const busy = seedSheet(t, orgId, projectId, 'setBusy', {}, { status: 'processing' });
      const nr = await http.post(`${P()}/corrections`).set(auth('editor')).send(add(busy));
      expect(nr.status).toBe(409);
      expect(ApiErrorSchema.parse(nr.body).error.code).toBe('not_ready');
      expect((await http.post(`${P()}/corrections`).set(auth('editor')).send({ ...add(), anchorMm: { x: 5000, y: 10 } })).status).toBe(400);
      expect((await http.post(`${P()}/corrections`).set(auth('editor')).send({ ...add(), class: null })).status).toBe(400);
      expect((await http.post(`${P()}/corrections`).set(auth('editor')).send({ ...add(), by: 'someone-else' })).status).toBe(400);
      expect((await http.post(`${P()}/corrections`).set(auth('editor')).send({ ...add(), class: 'unknown' })).status).toBe(400);
    });
  });

  describe('role matrix + isolation', () => {
    it('accept/reject: reviewer+; other kinds: editor+; viewer never; outsider 404; anonymous 401', async () => {
      expect((await http.post(`${P()}/corrections`).set(auth('viewer')).send(accept())).status).toBe(403);
      expect((await http.post(`${P()}/corrections`).set(auth('reviewer')).send(add())).status).toBe(403);
      expect((await http.post(`${P()}/corrections`).set(auth('reviewer')).send({ ...accept(), kind: 'reject' })).status).toBe(201);
      for (const who of ['editor', 'admin']) expect((await http.post(`${P()}/corrections`).set(auth(who)).send(add())).status).toBe(201);
      expect((await http.post(`${P()}/corrections`).set(auth('outsider')).send(accept())).status).toBe(404);
      expect((await http.post(`${P()}/corrections`).send(accept())).status).toBe(401);
      expect((await http.get(`${P()}/corrections`).set(auth('outsider'))).status).toBe(404);
      finishPending();
    });

    it('reviewer cannot revert an editor-only kind; cross-org ids are 404 everywhere', async () => {
      const c = CreateCorrectionResponseSchema.parse((await http.post(`${P()}/corrections`).set(auth('editor')).send(add())).body).correction;
      expect((await http.post(`${P()}/corrections/${c.id}/revert`).set(auth('reviewer'))).status).toBe(403);
      // org B admin with org A ids, and org A sheet ids under org B's project
      expect((await http.post(`${P()}/corrections/${c.id}/revert`).set(auth('outsider'))).status).toBe(404);
      expect((await http.post(`${P(otherProject)}/corrections/${c.id}/revert`).set(auth('outsider'))).status).toBe(404);
      expect((await http.post(`${P(otherProject)}/corrections`).set(auth('outsider')).send(add(sheet))).status).toBe(404);
      expect((await http.post(`${P(otherProject)}/corrections`).set(auth('editor')).send(add(otherSheet))).status).toBe(404);
      expect((await http.get(`${P()}/review-queue`).set(auth('outsider'))).status).toBe(404);
      expect((await http.get(`${P()}/rooms/${sheet.sheetId}/r_1/settings`).set(auth('outsider'))).status).toBe(404);
      expect((await http.get(`${P(otherProject)}/rooms/${sheet.sheetId}/r_1/settings`).set(auth('outsider'))).status).toBe(404);
      // org B never sees A's corrections
      const bList = CorrectionPageSchema.parse((await http.get(`${P(otherProject)}/corrections`).set(auth('outsider'))).body);
      expect(bList.items).toHaveLength(0);
      finishPending();
    });
  });

  describe('POST /corrections/batch', () => {
    it('≤ 500 items, one batchId, one audit event; 501 → 400; mixed kinds by a reviewer → 403', async () => {
      const items = Array.from({ length: 500 }, (_, i) => ({ ...accept(`d_${i}`), anchorMm: { x: 10 + (i % 50), y: 10 + Math.floor(i / 50) } }));
      const auditsBefore = audits().length;
      const r = await http.post(`${P()}/corrections/batch`).set(auth('reviewer')).send({ items, source: 'cluster' });
      expect(r.status).toBe(201);
      const body = CreateCorrectionBatchResponseSchema.parse(r.body);
      expect(body.items).toHaveLength(500);
      expect(new Set(body.items.map((c) => c.batchId))).toEqual(new Set([body.batch.id]));
      expect(body.batch).toMatchObject({ count: 500, kinds: { accept: 500 }, source: 'cluster', sheetIds: [sheet.sheetId] });
      const newAudits = audits().slice(auditsBefore);
      expect(newAudits.filter((a) => a.entity === 'corrections')).toHaveLength(1);
      expect((newAudits[0]?.after as Doc).correctionIds).toHaveLength(500);
      expect((await http.post(`${P()}/corrections/batch`).set(auth('reviewer')).send({ items: [...items, accept()] })).status).toBe(400);
      expect((await http.post(`${P()}/corrections/batch`).set(auth('reviewer')).send({ items: [accept(), add()] })).status).toBe(403);
      expect((await http.post(`${P()}/corrections/batch`).set(auth('reviewer')).send({ items: [] })).status).toBe(400);
      // all-or-nothing: one bad target → nothing written
      const count = [...t.repo.docs.keys()].filter((k) => k.includes('/corrections/')).length;
      expect((await http.post(`${P()}/corrections/batch`).set(auth('editor')).send({ items: [add(), { ...add(), versionId: 'gone' }] })).status).toBe(404);
      expect([...t.repo.docs.keys()].filter((k) => k.includes('/corrections/')).length).toBe(count);
      // batch revert = one undo step
      const rv = await http.post(`${P()}/correction-batches/${body.batch.id}/revert`).set(auth('reviewer'));
      expect(rv.status).toBe(200);
      expect(RevertCorrectionBatchResponseSchema.parse(rv.body)).toMatchObject({ reverted: 500 });
      expect((await http.post(`${P()}/correction-batches/${body.batch.id}/revert`).set(auth('reviewer'))).status).toBe(409);
      expect((await http.post(`${P(otherProject)}/correction-batches/${body.batch.id}/revert`).set(auth('outsider'))).status).toBe(404);
      const listed = CorrectionPageSchema.parse((await http.get(`${P()}/corrections`).query({ batchId: body.batch.id, includeReverted: 'true', limit: 500 }).set(auth('viewer'))).body);
      expect(listed.items.every((c) => c.revertedAt !== null)).toBe(true);
      finishPending();
    });

    it('geometry cap: > 20 000 points per batch → 400', async () => {
      const pts = Array.from({ length: 2000 }, (_, i) => ({ x: 10 + (i % 100), y: 10 + Math.floor(i / 100) }));
      const item = { kind: 'count', sheetId: sheet.sheetId, versionId: sheet.versionId, anchorMm: { x: 10, y: 10 }, itemCode: '3.06', geometry: { type: 'point', mm: pts } };
      expect((await http.post(`${P()}/corrections/batch`).set(auth('editor')).send({ items: Array(11).fill(item) })).status).toBe(400);
      // > 2 MB body → 413 payload_too_large (not a 500)
      const huge = await http.post(`${P()}/corrections/batch`).set(auth('editor')).set('content-type', 'application/json').send(JSON.stringify({ items: Array(150).fill(item) }));
      expect(huge.status).toBe(413);
      expect(ApiErrorSchema.parse(huge.body).error.code).toBe('payload_too_large');
    });
  });

  // ---------------------------------------------------------------- room settings
  describe('room settings', () => {
    const url = (room = 'r_1', s = sheet) => `${P()}/rooms/${s.sheetId}/${room}/settings`;
    const body = { claddingHeightM: 2.4, floorTiled: true, floorMaterialItemCode: null, wallMaterialItemCode: '5.01', partialCladding: [{ wallId: 'w_2', fromM: 0, toM: 1.2, heightM: 1 }], wasteFactor: 0.08, includeInWaterproofing: true, keepOpenings: ['o_1'] };

    it('GET: type defaults (bathroom 2.6 m) + room facts; unknown room 404', async () => {
      const r = RoomSettingsResponseSchema.parse((await http.get(url()).set(auth('viewer'))).body);
      expect(r.isDefault).toBe(true);
      // rules v4: no shower / bath detected in the room → not waterproofed by default
      expect(r.settings).toMatchObject({ claddingHeightM: 2.6, floorTiled: true, includeInWaterproofing: false, wasteFactor: 0.07, sheetId: sheet.sheetId, roomId: 'r_1' });
      expect(r.room).toMatchObject({ type: 'bathroom', wet: true, perimeterM: 9, externalCorners: 1, hasShowerOrBath: false });
      expect(r.room?.walls.map((w) => w.id)).toEqual(['w_1', 'w_2']);
      expect((await http.get(url('r_404')).set(auth('viewer'))).status).toBe(404);
      expect((await http.get(url('not-a-room')).set(auth('viewer'))).status).toBe(404);
    });

    it('PUT validation against the room: unknown wall, beyond wall length, overlap, unknown opening, bounds, strict', async () => {
      const put = (b: object) => http.put(url()).set(auth('editor')).send(b);
      expect((await put({ ...body, partialCladding: [{ wallId: 'w_9', fromM: 0, toM: 1, heightM: 1 }] })).status).toBe(400);
      expect((await put({ ...body, partialCladding: [{ wallId: 'w_2', fromM: 0, toM: 3, heightM: 1 }] })).status).toBe(400);
      expect((await put({ ...body, partialCladding: [{ wallId: 'w_2', fromM: 0, toM: 1, heightM: 1 }, { wallId: 'w_2', fromM: 0.5, toM: 1.5, heightM: 1 }] })).status).toBe(400);
      expect((await put({ ...body, keepOpenings: ['o_9'] })).status).toBe(400);
      expect((await put({ ...body, claddingHeightM: 9 })).status).toBe(400);
      expect((await put({ ...body, wasteFactor: -0.1 })).status).toBe(400);
      expect((await put({ ...body, extra: true })).status).toBe(400);
      expect((await http.put(url('r_404')).set(auth('editor')).send(body)).status).toBe(404);
    });

    it('v4 defaults: cladding capped at the room ceiling, waterproofing only with a shower/bath; PUT above the ceiling → 400', async () => {
      const s2 = seedSheet(t, orgId, projectId, 'setCeil', {
        detections: [det('d_sh', 'fixture_shower', 110, 110, 0.9, 'green', { roomId: 'r_1' })],
        rooms: [bathroom('r_1', { ceilingHeightM: 2.4 }), { ...bathroom('r_2'), type: 'wc' }, { ...bathroom('r_3'), niche: true }],
      });
      const g = (room: string) => http.get(url(room, s2)).set(auth('viewer')).then((r) => RoomSettingsResponseSchema.parse(r.body));
      const r1 = await g('r_1');
      expect(r1.settings).toMatchObject({ claddingHeightM: 2.4, ceilingHeightM: 2.4, includeInWaterproofing: true });
      expect(r1.room).toMatchObject({ ceilingHeightM: 2.4, hasShowerOrBath: true });
      expect((await g('r_2')).settings).toMatchObject({ claddingHeightM: 2.6, includeInWaterproofing: false });
      expect((await g('r_3')).settings).toMatchObject({ claddingHeightM: 0, floorTiled: true, includeInWaterproofing: false });
      const put = await http.put(url('r_1', s2)).set(auth('editor')).send({ ...body, partialCladding: [], keepOpenings: [], claddingHeightM: 2.6 });
      expect(put.status).toBe(400);
    });

    it('overlay manifest signs fixtures.json.gz / walls.json.gz when the version has them', async () => {
      const vPath = fsPaths.version(orgId, projectId, sheet.sheetId, sheet.versionId);
      const v = t.repo.docs.get(vPath) as Doc;
      t.repo.docs.set(vPath, { ...v, artifacts: { ...(v.artifacts as Doc), fixtures: 'x', walls: 'y' } });
      const r = await http.get(`${P()}/sheets/${sheet.sheetId}/versions/${sheet.versionId}/overlay`).set(auth('viewer'));
      expect(r.status).toBe(200);
      expect(r.body.fixtures.url).toContain(encodeURI(storagePaths.fixtures(orgId, projectId, sheet.sheetId, sheet.versionId)));
      expect(r.body.walls.url).toContain(encodeURI(storagePaths.walls(orgId, projectId, sheet.sheetId, sheet.versionId)));
      t.repo.docs.set(vPath, v);
      const r2 = await http.get(`${P()}/sheets/${sheet.sheetId}/versions/${sheet.versionId}/overlay`).set(auth('viewer'));
      expect(r2.body).toMatchObject({ fixtures: null, walls: null });
    });

    it('PUT editor+ → stored, audited, BOQ stale (room) + rebuild; viewer/reviewer 403; GET returns stored', async () => {
      for (const who of ['viewer', 'reviewer']) expect((await http.put(url()).set(auth(who)).send(body)).status).toBe(403);
      const r = await http.put(url()).set(auth('editor')).send(body);
      expect(r.status).toBe(200);
      const res = RoomSettingsResponseSchema.parse(r.body);
      expect(res).toMatchObject({ isDefault: false, settings: { claddingHeightM: 2.4, by: 'editor' }, rebuild: { stale: true } });
      expect(projectBoq().staleReason).toBe('room');
      expect(audits().find((a) => a.entity === 'roomSettings')).toMatchObject({ action: 'update', entityId: `${sheet.sheetId}__r_1`, after: expect.objectContaining({ claddingHeightM: 2.4, partialCladding: 1, created: true }) });
      const g = RoomSettingsResponseSchema.parse((await http.get(url()).set(auth('viewer'))).body);
      expect(g.isDefault).toBe(false);
      expect(g.settings.partialCladding).toEqual(body.partialCladding);
      finishPending();
    });
  });

  // ---------------------------------------------------------------- find similar
  describe('similar searches', () => {
    const exemplar = () => ({ sheetId: sheet.sheetId, versionId: sheet.versionId, bboxMm: { x: 48, y: 48, w: 4, h: 4 }, class: 'socket_double' });

    it('POST reviewer → 202 + find_similar job/message + audit; viewer 403; outsider 404; not-ready 409; outside page 400', async () => {
      expect((await http.post(`${P()}/similar-searches`).set(auth('viewer')).send({ exemplar: exemplar() })).status).toBe(403);
      expect((await http.post(`${P()}/similar-searches`).set(auth('outsider')).send({ exemplar: exemplar() })).status).toBe(404);
      const busy = seedSheet(t, orgId, projectId, 'setBusy2', {}, { status: 'processing' });
      expect((await http.post(`${P()}/similar-searches`).set(auth('reviewer')).send({ exemplar: { ...exemplar(), ...busy } })).status).toBe(409);
      expect((await http.post(`${P()}/similar-searches`).set(auth('reviewer')).send({ exemplar: { ...exemplar(), bboxMm: { x: 900, y: 10, w: 4, h: 4 } } })).status).toBe(400);
      const r = await http.post(`${P()}/similar-searches`).set(auth('reviewer')).send({ exemplar: exemplar(), scope: 'sheet' });
      expect(r.status).toBe(202);
      const body = CreateSimilarSearchResponseSchema.parse(r.body);
      expect(body.search).toMatchObject({ status: 'queued', scope: 'sheet', requestedBy: 'reviewer', candidates: [] });
      const msg = t.queue.messages.at(-1);
      expect(msg?.attributes).toMatchObject({ type: 'symbols.find_similar', orgId, jobId: body.jobId });
      expect(FindSimilarJobSchema.parse(msg?.data)).toMatchObject({ searchId: body.search.id, scope: 'sheet', exemplar: exemplar() });
      expect(t.repo.docs.get(fsPaths.job(body.jobId))).toMatchObject({ type: 'symbols.find_similar', orgId, searchId: body.search.id });
      expect(audits().at(-1)).toMatchObject({ entity: 'similarSearches', action: 'request', entityId: body.search.id });
    });

    it('GET after the worker: candidates (bad ones dropped) + signed crops under similar/ only for candidates with a crop', async () => {
      const { search } = CreateSimilarSearchResponseSchema.parse((await http.post(`${P()}/similar-searches`).set(auth('reviewer')).send({ exemplar: exemplar() })).body);
      const q0 = SimilarSearchViewSchema.parse((await http.get(`${P()}/similar-searches/${search.id}`).set(auth('viewer'))).body);
      expect(q0).toMatchObject({ search: { status: 'queued' }, thumbUrls: {}, expiresAt: null });
      const c = (id: string, score: number, thumb: string | null) => ({ id, sheetId: sheet.sheetId, versionId: sheet.versionId, centerMm: { x: 1, y: 1 }, bboxMm: { x: 0, y: 0, w: 2, h: 2 }, score, alreadyDetected: null, currentClass: null, thumb });
      review.completeSimilarSearch(orgId, projectId, search.id, [c('c_1', 0.7, 'c_1.webp'), c('c_2', 0.9, null), c('c_3', 0.8, '../../x.webp'), { junk: true }, c('c_1', 0.1, null)]);
      const v = SimilarSearchViewSchema.parse((await http.get(`${P()}/similar-searches/${search.id}`).set(auth('viewer'))).body);
      expect(v.search.status).toBe('succeeded');
      expect(v.search.candidates.map((x) => x.id)).toEqual(['c_2', 'c_1']); // score desc, junk + duplicates + bad thumbs dropped
      expect(Object.keys(v.thumbUrls)).toEqual(['c_1']);
      expect(v.thumbUrls.c_1).toContain(encodeURI(storagePaths.similarThumb(orgId, projectId, search.id, 'c_1')));
      expect(v.expiresAt).not.toBeNull();
      expect((await http.get(`${P(otherProject)}/similar-searches/${search.id}`).set(auth('outsider'))).status).toBe(404);
      expect((await http.get(`${P()}/similar-searches/nope`).set(auth('viewer'))).status).toBe(404);
      // "apply" = a batch with the search id
      const apply = await http
        .post(`${P()}/corrections/batch`)
        .set(auth('editor'))
        .send({ items: [{ ...add(), anchorMm: { x: 1, y: 1 } }], source: 'similar', similarSearchId: search.id });
      expect(CreateCorrectionBatchResponseSchema.parse(apply.body).batch).toMatchObject({ source: 'similar', similarSearchId: search.id });
      expect((await http.post(`${P()}/corrections/batch`).set(auth('editor')).send({ items: [add()], similarSearchId: 'nope' })).status).toBe(404);
      finishPending();
    });

    it('publish failure → 503 and the search is marked failed', async () => {
      const spy = vi.spyOn(t.queue, 'publish').mockRejectedValueOnce(new Error('down'));
      const r = await http.post(`${P()}/similar-searches`).set(auth('reviewer')).send({ exemplar: exemplar() });
      spy.mockRestore();
      expect(r.status).toBe(503);
      const docs = [...t.repo.docs.entries()].filter(([k]) => k.includes('/similarSearches/'));
      expect(docs.some(([, d]) => d.status === 'failed')).toBe(true);
    });
  });

  // ---------------------------------------------------------------- review queue
  describe('GET /review-queue', () => {
    let qp: string;
    let qs: { sheetId: string; versionId: string };
    let unmatchedId: string;
    const BUILD = 'build1';

    beforeAll(async () => {
      qp = (await t.repo.createProject(orgId, { name: 'Queue' }, 'editor')).id;
      qs = seedSheet(t, orgId, qp, 'setQ', {
        detections: [
          det('d_1', 'socket_double', 10, 10, 0.7, 'yellow', { legendEntryId: 'le_1' }),
          det('d_2', 'socket_double', 20, 10, 0.6, 'yellow', { legendEntryId: 'le_1' }),
          det('d_3', 'socket_double', 30, 10, 0.8, 'yellow', { legendEntryId: 'le_1' }),
          det('d_10', 'socket_power', 40, 10, 0.3, 'red'),
          det('d_11', 'luminaire_ceiling', 50, 10, 0.5, 'yellow'),
          det('d_12', 'luminaire_ceiling', 60, 10, 0.95, 'green'),
          det('d_13', 'socket_single', 70, 10, 0.4, 'yellow'), // accepted in the build (verified) → not queued
          det('d_20', 'unknown', 80, 10, 0.2, 'red', { clusterId: 'u_1' }),
          det('d_21', 'unknown', 90, 10, 0.2, 'red', { clusterId: 'u_1' }),
          det('d_s', 'switch_single', 100, 10, 0.9, 'green'),
        ],
        unknownClusters: [{ id: 'u_1', signature: 'sigUNKNOWN01', count: 2, exemplarBboxMm: { x: 78, y: 8, w: 4, h: 4 }, thumb: 'unknown/u_1.webp' }],
        rooms: [bathroom('r_1'), { ...bathroom('r_2'), name: null, type: 'bedroom', wet: false, walls: [], openings: [] }],
        groups: [{ id: 'lk_1', switchIds: ['d_s'], pointIds: ['d_11'], luminaireIds: ['d_11'], kind: 'single', confidence: 0.4, level: 'yellow', reasons: ['קשת לא ודאית'] }],
      });
      const c = CreateCorrectionResponseSchema.parse((await http.post(`${P(qp)}/corrections`).set(auth('editor')).send({ ...add(qs), anchorMm: { x: 300, y: 300 } })).body).correction;
      unmatchedId = c.id;
      finishPending(orgId, qp);
      const seed = (id: string, code: string, level: 'green' | 'yellow' | 'red', extra: Record<string, unknown> = {}) => t.boq.seedLine(orgId, qp, { id, code, level, buildId: BUILD, ...extra });
      seed('L401', '4.01', 'yellow', { qty: 3 });
      seed('L403', '4.03', 'red');
      seed('L909', '9.01', 'yellow');
      seed('L424', '4.24', 'red', { reasons: ['שיוך לפריט לפי כלל ברירת מחדל'] });
      seed('L308', '3.08', 'yellow', { chapter: '03', reasons: ['הצעה – לאשר ידנית'] });
      seed('L400', '4.00', 'yellow', { status: 'approved' });
      const ev = (detectionId: string, extra: Record<string, unknown> = {}) => ({ sheetId: qs.sheetId, versionId: qs.versionId, detectionId, linkGroupId: null, floor: '0', ...extra });
      t.boqStorage.putEvidence(storagePaths.boqEvidence(orgId, qp, BUILD), {
        schema: 'kamutan.boq-evidence/1',
        buildId: BUILD,
        lines: {
          L401: [ev('d_1'), ev('d_2'), ev('d_3')],
          L403: [ev('d_10')],
          L909: [ev('d_11', { linkGroupId: 'lk_1' }), ev('d_s', { linkGroupId: 'lk_1' })],
          L400: [ev('d_13', { verified: true, source: 'auto' })],
        },
        corrections: { applied: [], unmatched: [{ correctionId: unmatchedId, sheetId: qs.sheetId, versionId: qs.versionId, reason: 'לא נמצא סמל ליד העוגן' }] },
      });
      const p = t.repo.docs.get(fsPaths.project(orgId, qp)) as Doc;
      t.repo.docs.set(fsPaths.project(orgId, qp), { ...p, boq: { ...(p.boq as Doc), latestBuildId: BUILD } });
    });

    const get = async (query: Record<string, string> = {}, who = 'viewer') => ReviewQueuePageSchema.parse((await http.get(`${P(qp)}/review-queue`).query(query).set(auth(who))).body);

    it('ranked by risk = |impact| × (1 − score) × level weight, deterministic tie-break', async () => {
      const page = await get({ limit: '200' });
      const ids = page.items.map((i) => i.id);
      expect(ids).toEqual([
        `uc:${qs.sheetId}:${qs.versionId}:u_1`, // 2 × 1 × 3 = 6
        `corr:${unmatchedId}`, // 1 × 1 × 3 = 3
        'line:L424', // 1 × 0.75 × 3 = 2.25 (red, no per-item cause)
        `det:${qs.sheetId}:${qs.versionId}:d_10`, // 0.7 × 3 = 2.1 (counted in 4.03 → no separate line card)
        `room:${qs.sheetId}:r_1`, // 5 m² × 0.4 × 1 = 2 (settings missing)
        expect.stringMatching(/^cl:/), // 0.3 + 0.4 + 0.2 = 0.9
        `lg:${qs.sheetId}:${qs.versionId}:lk_1`, // 0.6
        `det:${qs.sheetId}:${qs.versionId}:d_11`, // 0.5
        `room:${qs.sheetId}:r_2`, // 0.4 (unnamed) — room before line on equal risk
        'line:L308', // 0.4
      ]);
      expect(page.items.map((i) => i.risk)).toEqual([6, 3, 2.25, 2.1, 2, 0.9, 0.6, 0.5, 0.4, 0.4]);
      const cl = page.items[5];
      expect(cl).toMatchObject({ kind: 'cluster', count: 3, detectionIds: ['d_2', 'd_1', 'd_3'], itemCode: '4.01', lineIds: ['L401'], suggestedAction: 'accept' });
      expect(cl?.title).toContain('3 מופעים');
      expect(page.items[0]).toMatchObject({ kind: 'unknown_cluster', level: 'red', detectionIds: ['d_20', 'd_21'], suggestedAction: 'resolve_unknown' });
      expect(page.items[0]?.thumbUrl).toContain(encodeURI(storagePaths.unknownThumb(orgId, qp, qs.sheetId, qs.versionId, 'u_1')));
      expect(page.items[1]).toMatchObject({ kind: 'unmatched_correction', level: 'red', title: expect.stringContaining('תיקון לא הותאם'), reasons: ['לא נמצא סמל ליד העוגן'], suggestedAction: 'redo_correction' });
      expect(page.items[4]).toMatchObject({ kind: 'room', suggestedAction: 'room_settings', reasons: ['חסרות הגדרות ריצוף/חיפוי'] });
      expect(page.items[8]).toMatchObject({ kind: 'room', suggestedAction: 'name_room', reasons: ['חדר ללא שם'] });
      expect(page).toMatchObject({ total: 10, buildId: BUILD, counts: { byLevel: { red: 4, yellow: 6 }, byKind: { detection: 2, cluster: 1, unknown_cluster: 1, link_group: 1, room: 2, unmatched_correction: 1, line: 2 } } });
      // same order on every call
      expect((await get({ limit: '200' })).items.map((i) => i.id)).toEqual(ids);
    });

    it('filters (kind / sheet / floor / level) and paging with a cursor', async () => {
      expect((await get({ kind: 'room' })).items.map((i) => i.kind)).toEqual(['room', 'room']);
      expect((await get({ level: 'red' })).total).toBe(4);
      expect((await get({ sheetId: 'other-sheet' })).total).toBe(0);
      expect((await get({ floor: '0' })).items.every((i) => i.floor === '0')).toBe(true);
      const p1 = await get({ limit: '4' });
      const p2 = await get({ limit: '4', cursor: p1.nextCursor as string });
      const p3 = await get({ limit: '4', cursor: p2.nextCursor as string });
      expect(p3.nextCursor).toBeNull();
      expect([...p1.items, ...p2.items, ...p3.items].map((i) => i.id)).toEqual((await get({ limit: '200' })).items.map((i) => i.id));
      expect((await http.get(`${P(qp)}/review-queue`).query({ cursor: 'x' }).set(auth('viewer'))).status).toBe(400);
    });

    it('corrections overlay: accept removes a detection, partial cluster accept shrinks it, settings drop the room item, revert brings back', async () => {
      const svc = t.app.get(ReviewQueueService);
      const computedBefore = svc.computations;
      const acc = (id: string, x: number) => ({ kind: 'accept', sheetId: qs.sheetId, versionId: qs.versionId, anchorMm: { x, y: 10 }, detectionId: id });
      const a = CreateCorrectionResponseSchema.parse((await http.post(`${P(qp)}/corrections`).set(auth('reviewer')).send(acc('d_10', 40))).body).correction;
      await http.post(`${P(qp)}/corrections`).set(auth('reviewer')).send(acc('d_2', 20));
      await http.put(`${P(qp)}/rooms/${qs.sheetId}/r_1/settings`).set(auth('editor')).send({ claddingHeightM: 2.6, floorTiled: true, floorMaterialItemCode: null, wallMaterialItemCode: null, partialCladding: [], wasteFactor: 0.07, includeInWaterproofing: true });
      const after = await get({ limit: '200' });
      const ids = after.items.map((i) => i.id);
      expect(ids).not.toContain(`det:${qs.sheetId}:${qs.versionId}:d_10`);
      expect(ids).not.toContain(`room:${qs.sheetId}:r_1`);
      expect(after.items.find((i) => i.kind === 'cluster')).toMatchObject({ count: 2, detectionIds: ['d_1', 'd_3'], risk: 0.5 });
      // revert of the unmatched correction removes the red "not matched" card
      await http.post(`${P(qp)}/corrections/${unmatchedId}/revert`).set(auth('editor'));
      await http.post(`${P(qp)}/corrections/${a.id}/revert`).set(auth('reviewer'));
      const again = (await get({ limit: '200' })).items.map((i) => i.id);
      expect(again).not.toContain(`corr:${unmatchedId}`);
      expect(again).toContain(`det:${qs.sheetId}:${qs.versionId}:d_10`);
      // the build-derived part was computed once for this build
      expect(svc.computations).toBe(computedBefore);
      finishPending(orgId, qp);
    });

    it('a correction made on an older version handles the re-detected item within its radius', async () => {
      const old = 'oldVersion1';
      t.repo.docs.set(fsPaths.version(orgId, qp, qs.sheetId, old), { ...(t.repo.docs.get(fsPaths.version(orgId, qp, qs.sheetId, qs.versionId)) as Doc) });
      await http.post(`${P(qp)}/corrections`).set(auth('reviewer')).send({ kind: 'reject', sheetId: qs.sheetId, versionId: old, anchorMm: { x: 51, y: 10 }, radiusMm: 3, detectionId: 'd_old_77' });
      const ids = (await get({ limit: '200' })).items.map((i) => i.id);
      expect(ids).not.toContain(`det:${qs.sheetId}:${qs.versionId}:d_11`);
      finishPending(orgId, qp);
    });

    it('2,000 detections: < 300 ms (cached per build), first computation bounded', async () => {
      const pp = (await t.repo.createProject(orgId, { name: 'Big' }, 'editor')).id;
      const classes = ['socket_single', 'socket_double', 'socket_power', 'luminaire_ceiling', 'switch_single'];
      const dets = Array.from({ length: 2000 }, (_, i) => det(`d_${i}`, classes[i % 5] as string, 10 + (i % 80) * 10, 10 + Math.floor(i / 80) * 20, (i % 97) / 100, i % 3 === 0 ? 'red' : i % 3 === 1 ? 'yellow' : 'green', { legendEntryId: `le_${i % 7}` }));
      seedSheet(t, orgId, pp, 'setBig', { detections: dets, rooms: Array.from({ length: 40 }, (_, i) => bathroom(`r_${i}`)) });
      const p = t.repo.docs.get(fsPaths.project(orgId, pp)) as Doc;
      t.repo.docs.set(fsPaths.project(orgId, pp), { ...p, boq: { latestBuildId: 'bigBuild', builtAt: null, stale: false } });
      const t0 = performance.now();
      const first = ReviewQueuePageSchema.parse((await http.get(`${P(pp)}/review-queue`).set(auth('viewer'))).body);
      const t1 = performance.now();
      const second = ReviewQueuePageSchema.parse((await http.get(`${P(pp)}/review-queue`).query({ cursor: '50' }).set(auth('viewer'))).body);
      const t2 = performance.now();
      expect(first.total).toBeGreaterThan(50);
      expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
      expect(t1 - t0).toBeLessThan(1500);
      expect(t2 - t1).toBeLessThan(300);
    });
  });
});
