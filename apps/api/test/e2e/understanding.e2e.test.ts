import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  fsPaths,
  JOB_TYPES,
  LegendEntryPageSchema,
  OverlayManifestSchema,
  PatchLegendEntryResponseSchema,
  ResolveUnknownClusterResponseSchema,
  storagePaths,
} from '@kamutan/contracts';
import type { Doc } from '../../src/db/mappers';
import { createTestApp, type TestApp } from '../support/app';
import { testConfig } from '../support/helpers';

const SIG_A = 'a1'.repeat(20);
const SIG_B = 'b2'.repeat(20);
const SIG_U = 'c3'.repeat(20);
const box = { x: 1, y: 2, w: 3, h: 4 };

const legendArtifact = (sheetId: string) => ({
  schema: 'kamutan.legend/1',
  legends: [{ id: 'lg0', bboxMm: box, title: 'מקרא', confidence: 0.9 }],
  entries: [0, 1, 2].map((n) => ({
    id: `le_${sheetId}_${n}`,
    legendId: 'lg0',
    symbolBboxMm: box,
    labelBboxMm: box,
    label: `שורה ${n}`,
    labelConfidence: 0.9,
    suggestedClass: 'socket_double',
    classConfidence: 0.8,
    signature: n === 0 ? SIG_A : SIG_B,
    thumb: n === 2 ? null : `legend/le_${sheetId}_${n}.webp`,
  })),
});

const detectionsArtifact = () => ({
  schema: 'kamutan.detections/1',
  detections: [],
  unknownClusters: [
    { id: 'u_0', signature: SIG_U, count: 7, exemplarBboxMm: box, thumb: 'unknown/u_0.webp' },
    { id: 'u_1', signature: 'not a valid signature!', count: 2, exemplarBboxMm: box, thumb: null },
  ],
});

describe('Understanding e2e — overlay, legend entries, unknown clusters (fake auth, in-memory everything)', () => {
  let t: TestApp;
  let http: ReturnType<typeof request>;
  const tok: Record<string, string> = {};
  let orgId: string;
  let otherOrg: string;
  let projectId: string;
  let otherProject: string;
  let sheetId: string;
  let versionId: string;
  let plainSheet: string;
  let plainVersion: string;
  let busySheet: string;
  let busyVersion: string;
  const auth = (who: string) => ({ authorization: `Bearer ${tok[who]}` });
  const audits = (o: string) =>
    [...t.repo.docs.entries()]
      .filter(([k]) => k.startsWith(`orgs/${o}/auditLog/`))
      .map(([, v]) => v)
      .sort((a, b) => (a.at as Date).getTime() - (b.at as Date).getTime());
  const entryUrl = (id: string, p = projectId) => `/api/v1/projects/${p}/legend-entries/${id}`;
  const overlayUrl = (s: string, v: string, p = projectId) => `/api/v1/projects/${p}/sheets/${s}/versions/${v}/overlay`;
  const resolveUrl = (c: string, p = projectId) => `/api/v1/projects/${p}/unknown-clusters/${c}/resolve`;

  beforeAll(async () => {
    t = await createTestApp(testConfig({ THROTTLE_LIMIT: '1000', UPLOAD_THROTTLE_LIMIT: '100', TILES_THROTTLE_LIMIT: '100' }));
    http = request(t.app.getHttpServer());
    for (const who of ['admin', 'editor', 'reviewer', 'viewer', 'outsider']) tok[who] = t.auth.issue(who);
    orgId = t.repo.seedOrg('Org', { admin: 'admin', editor: 'editor', reviewer: 'reviewer', viewer: 'viewer' }).id;
    otherOrg = t.repo.seedOrg('Other', { outsider: 'admin' }).id;
    projectId = (await t.repo.createProject(orgId, { name: 'P' }, 'editor')).id;
    otherProject = (await t.repo.createProject(otherOrg, { name: 'Q' }, 'outsider')).id;

    const sha = 'e'.repeat(64);
    await t.repo.createSheetSetIngest(orgId, projectId, {
      name: 'set.pdf', sha256: sha, fileKind: 'pdf', storagePath: storagePaths.projectUpload(orgId, projectId, sha, 'pdf'),
      uploadedBy: 'editor', uploadFileId: 'f1', sizeBytes: 10, jobType: JOB_TYPES.ingestSheetVersion,
    });
    ({ sheetId, versionId } = t.repo.seedWorkerSheet(orgId, projectId, sha, 0, { understanding: true }));
    ({ sheetId: plainSheet, versionId: plainVersion } = t.repo.seedWorkerSheet(orgId, projectId, sha, 1));
    ({ sheetId: busySheet, versionId: busyVersion } = t.repo.seedWorkerSheet(orgId, projectId, sha, 2, { understanding: true }));
    t.artifacts.putJson(storagePaths.legend(orgId, projectId, sheetId, versionId), legendArtifact(sheetId));
    t.artifacts.putJson(storagePaths.detections(orgId, projectId, sheetId, versionId), detectionsArtifact());
    t.artifacts.putJson(storagePaths.detections(orgId, projectId, busySheet, busyVersion), detectionsArtifact());

    for (const n of [0, 1, 2]) {
      t.repo.seedLegendEntry(orgId, projectId, `le_${sheetId}_${n}`, {
        sheetId,
        versionId,
        signature: n === 0 ? SIG_A : SIG_B,
        suggestedClass: n === 2 ? 'unknown' : 'socket_double',
        thumbPath: n === 2 ? null : storagePaths.legendThumb(orgId, projectId, sheetId, versionId, `le_${sheetId}_${n}`),
      });
    }
    // A worker doc pointing its thumb at another org's object: must never be signed.
    t.repo.seedLegendEntry(orgId, projectId, `le_${sheetId}_9`, {
      sheetId, versionId, signature: SIG_B, thumbPath: storagePaths.legendThumb(otherOrg, otherProject, sheetId, versionId, `le_${sheetId}_9`),
    });
    t.repo.seedLegendEntry(otherOrg, otherProject, 'le_x_0', { sheetId: 'x', versionId: 'v', signature: SIG_A });
  });

  afterAll(async () => {
    await t?.app.close();
  });

  // ------------------------------------------------------------------ overlay
  describe('GET overlay', () => {
    it('viewer gets signed artifact URLs, crop URLs for le_/u_ ids with a thumb, and stats', async () => {
      const res = await http.get(overlayUrl(sheetId, versionId)).set(auth('viewer')).expect(200);
      const m = OverlayManifestSchema.parse(res.body);
      expect(m.legend?.url).toContain(encodeURI(storagePaths.legend(orgId, projectId, sheetId, versionId)));
      expect(m.detections?.url).toContain('detections.json.gz');
      expect(m.rooms?.url).toContain('rooms.json.gz');
      expect(Object.keys(m.thumbs).sort()).toEqual([`le_${sheetId}_0`, `le_${sheetId}_1`, 'u_0'].sort());
      expect(m.thumbs.u_0).toContain(encodeURI(storagePaths.unknownThumb(orgId, projectId, sheetId, versionId, 'u_0')));
      for (const u of [m.legend!.url, ...Object.values(m.thumbs)]) expect(u).toContain(`/orgs/${orgId}/projects/${projectId}/`);
      expect(m.stats?.detections?.total).toBe(2);
      expect(Date.parse(m.expiresAt)).toBeGreaterThan(Date.now());
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('caches crop ids per version (artifacts are immutable)', async () => {
      const before = t.artifacts.reads;
      await http.get(overlayUrl(sheetId, versionId)).set(auth('editor')).expect(200);
      expect(t.artifacts.reads).toBe(before);
    });

    it('Sprint-1 version → all null; unknown version 404; not ready 409', async () => {
      const m = OverlayManifestSchema.parse((await http.get(overlayUrl(plainSheet, plainVersion)).set(auth('viewer')).expect(200)).body);
      expect(m).toMatchObject({ legend: null, detections: null, rooms: null, thumbs: {} });
      await http.get(overlayUrl(sheetId, 'nope')).set(auth('viewer')).expect(404);
      const q = t.repo.seedWorkerSheet(orgId, projectId, 'e'.repeat(64), 7, { status: 'processing' });
      const r = await http.get(overlayUrl(q.sheetId, q.versionId)).set(auth('viewer')).expect(409);
      expect(ApiErrorSchema.parse(r.body).error.code).toBe('not_ready');
    });

    it('cross-org: outsider 404 (also via their own project id), no token 401', async () => {
      await http.get(overlayUrl(sheetId, versionId)).set(auth('outsider')).expect(404);
      await http.get(overlayUrl(sheetId, versionId, otherProject)).set(auth('outsider')).expect(404);
      await http.get(overlayUrl(sheetId, versionId)).expect(401);
    });
  });

  // ------------------------------------------------------------------ list
  describe('GET legend-entries', () => {
    it('viewer lists with status filter + paging; crops signed only for their own derived path', async () => {
      const page1 = LegendEntryPageSchema.parse((await http.get(`/api/v1/projects/${projectId}/legend-entries?status=suggested&limit=2`).set(auth('viewer')).expect(200)).body);
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).toBe(page1.items[1]!.id);
      const page2 = LegendEntryPageSchema.parse(
        (await http.get(`/api/v1/projects/${projectId}/legend-entries?status=suggested&limit=2&cursor=${page1.nextCursor}`).set(auth('viewer')).expect(200)).body,
      );
      const all = [...page1.items, ...page2.items];
      expect(all.map((e) => e.id).sort()).toEqual([0, 1, 2, 9].map((n) => `le_${sheetId}_${n}`).sort());
      const byId = Object.fromEntries(all.map((e) => [e.id, e]));
      expect(byId[`le_${sheetId}_0`]!.thumbUrl).toContain(`/orgs/${orgId}/`);
      expect(byId[`le_${sheetId}_2`]!.thumbUrl).toBeNull();
      expect(byId[`le_${sheetId}_9`]!.thumbUrl).toBeNull(); // foreign path never signed
      expect(page1.expiresAt).not.toBeNull();
    });

    it('filters by sheetId; invalid status 400; outsider 404; other org entries never listed', async () => {
      const none = LegendEntryPageSchema.parse((await http.get(`/api/v1/projects/${projectId}/legend-entries?sheetId=${plainSheet}`).set(auth('viewer')).expect(200)).body);
      expect(none.items).toEqual([]);
      await http.get(`/api/v1/projects/${projectId}/legend-entries?status=bogus`).set(auth('viewer')).expect(400);
      await http.get(`/api/v1/projects/${projectId}/legend-entries`).set(auth('outsider')).expect(404);
      const mine = LegendEntryPageSchema.parse((await http.get(`/api/v1/projects/${projectId}/legend-entries`).set(auth('viewer')).expect(200)).body);
      expect(mine.items.map((e) => e.id)).not.toContain('le_x_0');
    });
  });

  // ------------------------------------------------------------------ patch
  describe('PATCH legend-entries/:entryId', () => {
    it('viewer and reviewer → 403; outsider → 404 (own project id too); cross-org entry id → 404', async () => {
      await http.patch(entryUrl(`le_${sheetId}_0`)).set(auth('viewer')).send({ action: 'confirm' }).expect(403);
      await http.patch(entryUrl(`le_${sheetId}_0`)).set(auth('reviewer')).send({ action: 'confirm' }).expect(403);
      await http.patch(entryUrl(`le_${sheetId}_0`)).set(auth('outsider')).send({ action: 'confirm' }).expect(404);
      await http.patch(entryUrl(`le_${sheetId}_0`, otherProject)).set(auth('outsider')).send({ action: 'confirm' }).expect(404);
      await http.patch(entryUrl('le_x_0')).set(auth('editor')).send({ action: 'confirm' }).expect(404);
      await http.patch(entryUrl('not-an-entry')).set(auth('editor')).send({ action: 'confirm' }).expect(404);
      expect(await t.repo.getSymbolMapping(orgId, SIG_A)).toBeNull();
    });

    it('rejects class ids outside the taxonomy, "unknown", extra keys; confirm without a usable suggestion', async () => {
      for (const body of [
        { action: 'confirm', class: 'socket_quadruple' },
        { action: 'reassign', class: 'unknown' },
        { action: 'reassign' },
        { action: 'ignore', class: 'socket_power' },
        { action: 'confirm', itemCode: 4.1 },
        { action: 'approve' },
      ]) {
        const r = await http.patch(entryUrl(`le_${sheetId}_0`)).set(auth('editor')).send(body).expect(400);
        expect(ApiErrorSchema.parse(r.body).error.code).toBe('validation_failed');
      }
      const r = await http.patch(entryUrl(`le_${sheetId}_2`)).set(auth('editor')).send({ action: 'confirm' }).expect(400); // suggestion is "unknown"
      expect(r.body.error.issues).toEqual([expect.objectContaining({ path: 'class' })]);
    });

    it('confirm → entry confirmed + org mapping (uses 1) + audit chained', async () => {
      const before = audits(orgId).length;
      const res = PatchLegendEntryResponseSchema.parse(
        (await http.patch(entryUrl(`le_${sheetId}_0`)).set(auth('editor')).send({ action: 'confirm', itemCode: '08.010' }).expect(200)).body,
      );
      expect(res.entry).toMatchObject({ status: 'confirmed', class: 'socket_double', itemCode: '08.010', confirmedBy: 'editor' });
      expect(res.mapping).toMatchObject({ signature: SIG_A, class: 'socket_double', itemCode: '08.010', label: 'שקע כפול', confirmedBy: 'editor', uses: 1 });
      const stored = t.repo.docs.get(fsPaths.symbolMapping(orgId, SIG_A)) as Doc;
      expect(Object.keys(stored).sort()).toEqual(['class', 'confirmedAt', 'confirmedBy', 'ignored', 'itemCode', 'label', 'uses']);
      expect(stored.ignored).toBe(false);
      const log = audits(orgId);
      expect(log).toHaveLength(before + 1);
      const ev = log.at(-1)!;
      expect(ev).toMatchObject({ actorId: 'editor', entity: 'legendEntries', entityId: `le_${sheetId}_0`, action: 'confirm' });
      expect(ev.after).toMatchObject({ projectId, signature: SIG_A, class: 'socket_double', itemCode: '08.010', previousStatus: 'suggested', mappingUses: 1 });
      expect(JSON.stringify(ev.after)).not.toContain('שקע'); // no OCR text in the audit log
      expect(ev.prevHash).toBe(log.at(-2)!.hash);
    });

    it('reassign (admin) on the same signature → uses++, new class, edited label persisted + used for the mapping; ignore → no mapping change', async () => {
      const res = PatchLegendEntryResponseSchema.parse(
        (
          await http
            .patch(entryUrl(`le_${sheetId}_0`))
            .set(auth('admin'))
            .send({ action: 'reassign', class: 'socket_power', itemCode: null, label: 'שקע כח מוגן מים' })
            .expect(200)
        ).body,
      );
      expect(res.entry).toMatchObject({ status: 'confirmed', class: 'socket_power', itemCode: null, label: 'שקע כח מוגן מים' });
      expect(res.mapping).toMatchObject({ class: 'socket_power', uses: 2, confirmedBy: 'admin', label: 'שקע כח מוגן מים', ignored: false });
      const ev = audits(orgId).at(-1)!;
      expect(ev).toMatchObject({ action: 'reassign', after: expect.objectContaining({ labelChanged: true }) });
      expect(JSON.stringify(ev.after)).not.toContain('מוגן'); // the text itself is not audited
      await http.patch(entryUrl(`le_${sheetId}_0`)).set(auth('editor')).send({ action: 'confirm', label: 'x'.repeat(301) }).expect(400);

      const ign = PatchLegendEntryResponseSchema.parse((await http.patch(entryUrl(`le_${sheetId}_1`)).set(auth('editor')).send({ action: 'ignore' }).expect(200)).body);
      expect(ign).toMatchObject({ entry: { status: 'ignored', class: null }, mapping: null });
      expect(await t.repo.getSymbolMapping(orgId, SIG_B)).toBeNull();
      expect(audits(orgId).at(-1)).toMatchObject({ entity: 'legendEntries', action: 'ignore' });
      expect(await t.repo.getSymbolMapping(otherOrg, SIG_A)).toBeNull(); // org memory is per org
    });
  });

  // ------------------------------------------------------------------ resolve
  describe('POST unknown-clusters/:clusterId/resolve', () => {
    const body = () => ({ sheetId, versionId, class: 'switch_2way', itemCode: '08.120', createLegendEntry: true });

    it('role + org checks, taxonomy validation, unknown cluster / version 404', async () => {
      await http.post(resolveUrl('u_0')).set(auth('viewer')).send(body()).expect(403);
      await http.post(resolveUrl('u_0')).set(auth('reviewer')).send(body()).expect(403);
      await http.post(resolveUrl('u_0')).set(auth('outsider')).send(body()).expect(404);
      await http.post(resolveUrl('u_0', otherProject)).set(auth('outsider')).send(body()).expect(404);
      await http.post(resolveUrl('u_0')).set(auth('editor')).send({ ...body(), class: 'unknown' }).expect(400);
      await http.post(resolveUrl('u_0')).set(auth('editor')).send({ ...body(), class: 'gizmo' }).expect(400);
      await http.post(resolveUrl('u_0')).set(auth('editor')).send({ ...body(), createLegendEntry: undefined }).expect(400);
      await http.post(resolveUrl('u_9')).set(auth('editor')).send(body()).expect(404);
      await http.post(resolveUrl('x_9')).set(auth('editor')).send(body()).expect(404);
      await http.post(resolveUrl('u_0')).set(auth('editor')).send({ ...body(), versionId: 'nope' }).expect(404);
      const r = await http.post(resolveUrl('u_1')).set(auth('editor')).send(body()).expect(409); // invalid signature in artifact
      expect(r.body.error.code).toBe('conflict');
      const nr = await http.post(resolveUrl('u_0')).set(auth('editor')).send({ ...body(), sheetId: plainSheet, versionId: plainVersion }).expect(409);
      expect(nr.body.error.code).toBe('not_ready');
      expect(await t.repo.getSymbolMapping(orgId, SIG_U)).toBeNull();
    });

    it('editor resolves: mapping + confirmed legend entry + audit + reprocess of the sheet', async () => {
      const published = t.queue.messages.length;
      const res = ResolveUnknownClusterResponseSchema.parse((await http.post(resolveUrl('u_0')).set(auth('editor')).send(body()).expect(200)).body);
      expect(res.mapping).toMatchObject({ signature: SIG_U, class: 'switch_2way', itemCode: '08.120', label: 'מחליף', uses: 1 });
      expect(res.legendEntry).toMatchObject({
        id: `le_${sheetId}_u_0`,
        status: 'confirmed',
        class: 'switch_2way',
        signature: SIG_U,
        thumbPath: storagePaths.unknownThumb(orgId, projectId, sheetId, versionId, 'u_0'),
      });
      expect(res.reprocess).toEqual([expect.objectContaining({ sheetId, status: 'queued', reason: null })]);
      expect(t.queue.messages.length).toBe(published + 1);
      expect((await t.repo.getSheet(orgId, projectId, sheetId))?.currentVersionId).toBe(res.reprocess[0]!.versionId);

      const actions = audits(orgId).slice(-2).map((e) => `${e.entity}/${e.action}`);
      expect(actions).toEqual(['unknownClusters/resolve', 'sheets/reprocess']);

      // The created entry is listed with its cluster crop signed.
      const list = LegendEntryPageSchema.parse((await http.get(`/api/v1/projects/${projectId}/legend-entries?status=confirmed`).set(auth('viewer')).expect(200)).body);
      const created = list.items.find((e) => e.id === `le_${sheetId}_u_0`);
      expect(created?.thumbUrl).toContain('/unknown/u_0.webp');
    });

    it('ignore ("לא רלוונטי"): exactly one of class / ignore; ignored mapping + ignored entry + audit "ignore"', async () => {
      const base = { sheetId, versionId, createLegendEntry: true };
      for (const bad of [{}, { ignore: false }, { ignore: true, class: 'switch_2way' }, { ignore: true, itemCode: '1.1' }]) {
        await http.post(resolveUrl('u_0')).set(auth('editor')).send({ ...base, ...bad }).expect(400);
      }
      await http.post(resolveUrl('u_0')).set(auth('viewer')).send({ ...base, ignore: true }).expect(403);
      // u_0 was resolved before (and the sheet reprocessed); resolve again on the old version as "not relevant".
      const res = ResolveUnknownClusterResponseSchema.parse((await http.post(resolveUrl('u_0')).set(auth('editor')).send({ ...base, ignore: true }).expect(200)).body);
      expect(res.mapping).toMatchObject({ signature: SIG_U, class: null, itemCode: null, ignored: true, label: 'לא רלוונטי' });
      expect(res.legendEntry).toMatchObject({ id: `le_${sheetId}_u_0`, status: 'ignored', class: null, itemCode: null });
      const stored = t.repo.docs.get(fsPaths.symbolMapping(orgId, SIG_U)) as Doc;
      expect(stored).toMatchObject({ class: null, itemCode: null, ignored: true });
      expect(audits(orgId).at(-1)).toMatchObject({ entity: 'unknownClusters', action: 'ignore', after: expect.objectContaining({ ignored: true, class: null }) });
      // Re-resolving with a class turns it back into a class mapping.
      const back = ResolveUnknownClusterResponseSchema.parse(
        (await http.post(resolveUrl('u_0')).set(auth('editor')).send({ sheetId, versionId, class: 'switch_2way', createLegendEntry: false }).expect(200)).body,
      );
      expect(back.mapping).toMatchObject({ class: 'switch_2way', ignored: false });
    });

    it('resolving on a version that is no longer current → mapping saved, reprocess skipped (not_current)', async () => {
      const res = ResolveUnknownClusterResponseSchema.parse(
        (await http.post(resolveUrl('u_0')).set(auth('editor')).send({ ...body(), createLegendEntry: false }).expect(200)).body,
      );
      expect(res.mapping?.uses).toBe(4);
      expect(res.legendEntry).toBeNull();
      expect(res.reprocess).toEqual([{ sheetId, status: 'skipped', reason: 'not_current', versionId: null, jobId: null }]);
    });

    it('after someone else started a reprocess → mapping saved, no second job (not_current)', async () => {
      await http.post(`/api/v1/projects/${projectId}/sheets/${busySheet}/reprocess`).set(auth('editor')).expect(202);
      const published = t.queue.messages.length;
      // The new queued version is current now; resolving on the version the user looked at does not queue again.
      const res = ResolveUnknownClusterResponseSchema.parse(
        (await http.post(resolveUrl('u_0')).set(auth('editor')).send({ ...body(), sheetId: busySheet, versionId: busyVersion, createLegendEntry: false }).expect(200)).body,
      );
      expect(res.reprocess[0]).toMatchObject({ status: 'skipped', reason: 'not_current' });
      expect(t.queue.messages.length).toBe(published);
    });
  });
});
