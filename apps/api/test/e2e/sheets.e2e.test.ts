import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  FinalizeUploadResponseSchema,
  JobSchema,
  PutRegionsResponseSchema,
  ReprocessSheetResponseSchema,
  SheetPageSchema,
  SheetSchema,
  SheetVersionSchema,
  TilesManifestSchema,
} from '@kamutan/contracts';
import { createTestApp, type TestApp } from '../support/app';
import { SAMPLE, testConfig } from '../support/helpers';

const rect = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

describe('Sheets / jobs e2e (/api/v1, fake auth + in-memory Firestore/Storage/PubSub + fake signer)', () => {
  let t: TestApp;
  let http: ReturnType<typeof request>;
  const tok: Record<string, string> = {};
  let orgId: string;
  let projectId: string;
  let setId: string;
  let jobId: string;
  let versionId: string;
  let sheetId: string;
  const auth = (who: string) => ({ authorization: `Bearer ${tok[who]}` });
  const base = () => `/api/v1/projects/${projectId}/sheets`;

  beforeAll(async () => {
    t = await createTestApp(testConfig({ THROTTLE_LIMIT: '1000', UPLOAD_THROTTLE_LIMIT: '100', TILES_THROTTLE_LIMIT: '4' }));
    http = request(t.app.getHttpServer());
    for (const who of ['editor', 'viewer', 'outsider']) tok[who] = t.auth.issue(who);
    orgId = t.repo.seedOrg('Org', { editor: 'editor', viewer: 'viewer' }).id;
    t.repo.seedOrg('Other', { outsider: 'admin' });
    projectId = (await t.repo.createProject(orgId, { name: 'P' }, 'editor')).id;

    // Upload through the real endpoints, then emulate the worker output.
    const up = await http.post(`/api/v1/projects/${projectId}/uploads`).set(auth('editor')).send({ filename: 'a.pdf', sizeBytes: SAMPLE.pdf.length }).expect(201);
    t.storage.put(up.body.storagePath, SAMPLE.pdf);
    const fin = FinalizeUploadResponseSchema.parse(
      (await http.post(`/api/v1/projects/${projectId}/sheet-sets`).set(auth('editor')).send({ uploadToken: up.body.uploadToken }).expect(201)).body,
    );
    setId = fin.sheetSet.id;
    jobId = fin.jobId;
    versionId = fin.versionId;
    sheetId = t.repo.seedWorkerSheet(orgId, projectId, setId, 0, { versionId }).sheetId;
    t.repo.seedWorkerSheet(orgId, projectId, setId, 1, { versionId, status: 'processing' });
  });

  afterAll(async () => {
    await t?.app.close();
  });

  it('GET sheets: contract shape for members, 404 for outsiders, 401 without a token', async () => {
    const res = await http.get(base()).set(auth('viewer')).expect(200);
    const page = SheetPageSchema.parse(res.body);
    expect(page.items.map((s) => [s.pageIndex, s.currentVersion?.status])).toEqual([
      [0, 'ready'],
      [1, 'processing'],
    ]);
    await http.get(base()).set(auth('outsider')).expect(404);
    await http.get(base()).expect(401);
    await http.get(`${base()}?limit=0`).set(auth('viewer')).expect(400);
  });

  it('GET version', async () => {
    const res = await http.get(`${base()}/${sheetId}/versions/${versionId}`).set(auth('viewer')).expect(200);
    expect(SheetVersionSchema.parse(res.body)).toMatchObject({ id: versionId, status: 'ready' });
    await http.get(`${base()}/${sheetId}/versions/nope`).set(auth('viewer')).expect(404);
  });

  it('GET tiles-manifest: signed batch + thumbnail, query validation, per-user rate limit', async () => {
    const res = await http.get(`${base()}/${sheetId}/versions/${versionId}/tiles-manifest?z=3&x0=0&x1=1&y0=0&y1=1`).set(auth('viewer')).expect(200);
    const m = TilesManifestSchema.parse(res.body);
    expect(Object.keys(m.urls).sort()).toEqual(['3/0_0', '3/0_1', '3/1_0', '3/1_1']);
    expect(m.thumbnailUrl).toMatch(/^https:\/\/storage\.invalid\//);
    expect(res.headers['cache-control']).toBe('no-store');
    await http.get(`${base()}/${sheetId}/versions/${versionId}/tiles-manifest?x0=0`).set(auth('viewer')).expect(400);
    await http.get(`${base()}/${sheetId}/versions/${versionId}/tiles-manifest?z=6&x0=0&x1=20&y0=0&y1=20`).set(auth('viewer')).expect(400);
    await http.get(`${base()}/${sheetId}/versions/${versionId}/tiles-manifest`).set(auth('outsider')).expect(404);
    // TILES_THROTTLE_LIMIT=4 per user: 3 used above by viewer (the 400s count too) → 1 left.
    await http.get(`${base()}/${sheetId}/versions/${versionId}/tiles-manifest`).set(auth('viewer')).expect(200);
    const limited = await http.get(`${base()}/${sheetId}/versions/${versionId}/tiles-manifest`).set(auth('viewer')).expect(429);
    expect(ApiErrorSchema.parse(limited.body).error.code).toBe('rate_limited');
    // Other users and other routes are unaffected.
    await http.get(`${base()}/${sheetId}/versions/${versionId}/tiles-manifest`).set(auth('editor')).expect(200);
    await http.get(base()).set(auth('viewer')).expect(200);
  });

  it('POST confirm (editor+), strict body, audited', async () => {
    const body = { discipline: 'electrical', floors: ['ground'], scaleDenominator: 50, regions: [{ id: 'r1', floor: 'ground', polygonMm: rect(10, 10, 300, 200), scaleDenominator: 50 }] };
    await http.post(`${base()}/${sheetId}/confirm`).set(auth('viewer')).send(body).expect(403);
    await http.post(`${base()}/${sheetId}/confirm`).set(auth('editor')).send({ ...body, confirmed: false }).expect(400);
    const res = await http.post(`${base()}/${sheetId}/confirm`).set(auth('editor')).send(body).expect(200);
    expect(SheetSchema.parse(res.body)).toMatchObject({ confirmed: true, confirmedBy: 'editor', scaleDenominator: 50 });
    const actions = [...t.repo.docs.entries()].filter(([k]) => k.startsWith(`orgs/${orgId}/auditLog/`)).map(([, v]) => v.action);
    expect(actions).toContain('confirm');
  });

  it('PUT regions: validated, ≤ 8, editor+', async () => {
    const r = (id: string, poly = rect(0, 0, 100, 100)) => ({ id, floor: 'first', polygonMm: poly, scaleDenominator: 100 });
    const ok = await http.put(`${base()}/${sheetId}/regions`).set(auth('editor')).send({ regions: [r('a'), r('b', rect(100, 0, 200, 100))] }).expect(200);
    expect(PutRegionsResponseSchema.parse(ok.body).regions).toHaveLength(2);
    const nine = Array.from({ length: 9 }, (_, i) => r(`r${i}`));
    await http.put(`${base()}/${sheetId}/regions`).set(auth('editor')).send({ regions: nine }).expect(400);
    const bad = await http.put(`${base()}/${sheetId}/regions`).set(auth('editor')).send({ regions: [r('a', rect(0, 0, 5000, 10))] }).expect(400);
    expect(bad.body.error).toMatchObject({ code: 'validation_failed', issues: [expect.objectContaining({ path: 'regions.0.polygonMm.1' })] });
    await http.put(`${base()}/${sheetId}/regions`).set(auth('viewer')).send({ regions: [] }).expect(403);
  });

  it('POST reprocess → 202 + publish; second call 409; GET job for members only', async () => {
    const before = t.queue.messages.length;
    const res = await http.post(`${base()}/${sheetId}/reprocess`).set(auth('editor')).expect(202);
    const body = ReprocessSheetResponseSchema.parse(res.body);
    expect(body.sheetVersion.regions).toHaveLength(2); // carried over from PUT regions
    expect(t.queue.messages.length).toBe(before + 1);
    await http.post(`${base()}/${sheetId}/reprocess`).set(auth('editor')).expect(409);

    const job = await http.get(`/api/v1/jobs/${body.jobId}`).set(auth('viewer')).expect(200);
    expect(JobSchema.parse(job.body)).toMatchObject({ sheetId, versionId: body.sheetVersion.id, status: 'queued' });
    await http.get(`/api/v1/jobs/${body.jobId}`).set(auth('outsider')).expect(404);
    await http.get(`/api/v1/jobs/${jobId}`).set(auth('viewer')).expect(200);
    await http.get(`/api/v1/jobs/${jobId}`).expect(401);
  });
});
