import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fsPaths, IngestSheetVersionJobSchema, REPROCESS_REASON_MESSAGE, type ReprocessRequest } from '@kamutan/contracts';
import type { Doc } from '../../src/db/mappers';
import { decideDependent, DependentsService } from '../../src/governance/dependents.service';
import { createTestApp, type TestApp } from '../support/app';
import { testConfig } from '../support/helpers';

describe('Sprint 5 — dependent re-process requests (Worker-B → scheduled consumer)', () => {
  let t: TestApp;
  let svc: DependentsService;
  let orgId: string;
  let projectId: string;
  let sheetId: string;
  let versionId: string;
  const now = Date.now();
  const nowSec = now / 1000;
  const reqPath = () => fsPaths.reprocessRequest(orgId, projectId, sheetId);
  const put = (d: Partial<ReprocessRequest> = {}) =>
    t.repo.docs.set(reqPath(), { sheetId, status: 'pending', dependentVersionId: versionId, sources: ['arch-p0/v9'], reason: 'reference_walls', firstRequestedAt: nowSec - 200, notBefore: nowSec - 1, updatedAt: nowSec - 200, ...d });
  const reqDoc = () => t.repo.docs.get(reqPath()) as Doc;

  beforeAll(async () => {
    t = await createTestApp(testConfig());
    svc = t.app.get(DependentsService);
    orgId = t.repo.seedOrg('O', { editor: 'editor' }).id;
    projectId = (await t.repo.createProject(orgId, { name: 'p' }, 'editor')).id;
    const setId = 'a'.repeat(64);
    t.repo.docs.set(fsPaths.sheetSet(orgId, projectId, setId), { fileKind: 'pdf', sha256: setId, storagePath: `orgs/${orgId}/projects/${projectId}/uploads/${setId}/source.pdf`, status: 'ready', name: 'x', createdAt: new Date() });
    ({ sheetId, versionId } = t.repo.seedWorkerSheet(orgId, projectId, setId, 3));
  });
  beforeEach(() => {
    const s = t.repo.docs.get(fsPaths.sheet(orgId, projectId, sheetId)) as Doc;
    t.repo.docs.set(fsPaths.sheet(orgId, projectId, sheetId), { ...s, currentVersionId: versionId });
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('decideDependent mirrors due_requests', () => {
    const r = { sheetId: 's', status: 'pending', dependentVersionId: 'v1', sources: ['a/1'], reason: 'reference_walls', firstRequestedAt: 0, notBefore: 0, updatedAt: 0 } as ReprocessRequest;
    expect(decideDependent(r, false, null)).toEqual({ kind: 'drop', reason: 'sheet_gone' });
    expect(decideDependent(r, true, { id: 'v1', status: 'processing' })).toEqual({ kind: 'wait' });
    expect(decideDependent(r, true, { id: 'v2', status: 'ready', referenceSources: ['a/1', 'b/2'] })).toMatchObject({ kind: 'drop' });
    expect(decideDependent(r, true, { id: 'v2', status: 'ready' })).toEqual({ kind: 'fire' }); // unknown refs → not used
    expect(decideDependent(r, true, { id: 'v1', status: 'ready', referenceSources: ['a/1'] })).toEqual({ kind: 'fire' });
  });

  it('not due yet (debounce) → untouched; due → ONE new version + ingest job + reprocessReason, then fired (idempotent)', async () => {
    put({ notBefore: nowSec + 60 });
    const before = t.queue.messages.length;
    expect(await svc.runDue(now)).toMatchObject({ fired: 0 });
    expect(reqDoc().status).toBe('pending');
    put();
    const [a, b] = await Promise.all([svc.runDue(now), svc.runDue(now)]);
    expect(a.fired + b.fired).toBe(1);
    expect(t.queue.messages.length).toBe(before + 1);
    const msg = IngestSheetVersionJobSchema.parse(t.queue.messages.at(-1)?.data);
    expect(msg).toMatchObject({ orgId, projectId, sheetId, pageIndex: 3 });
    expect(reqDoc()).toMatchObject({ status: 'fired', versionId: msg.versionId });
    expect(t.repo.docs.get(fsPaths.version(orgId, projectId, sheetId, msg.versionId))).toMatchObject({ status: 'queued', reprocessReason: { kind: 'reference_walls', sources: ['arch-p0/v9'], message: REPROCESS_REASON_MESSAGE } });
    expect((t.repo.docs.get(fsPaths.job(msg.jobId)) as Doc).createdBy).toBe('system_dependents');
    expect(await svc.runDue(now)).toMatchObject({ fired: 0 });
    expect(t.queue.messages.length).toBe(before + 1);
  });

  it('cap: notBefore beyond first + 900 s is fired at the cap; current version processing → stays pending', async () => {
    put({ notBefore: nowSec + 5000, firstRequestedAt: nowSec - 901 });
    // memory listing filters on notBefore like Firestore; the claim honours the cap
    expect(await t.gov.claimReprocessRequest(orgId, projectId, sheetId, nowSec)).toMatchObject({ status: 'firing' });
    put();
    // the version created by the previous test is `queued` → wait
    const s = t.repo.docs.get(fsPaths.sheet(orgId, projectId, sheetId)) as Doc;
    const cur = s.currentVersionId;
    t.repo.docs.set(fsPaths.sheet(orgId, projectId, sheetId), { ...s, currentVersionId: (t.queue.messages.at(-1)?.data as { versionId: string }).versionId });
    expect(await svc.runDue(now)).toMatchObject({ waiting: 1, fired: 0 });
    expect(reqDoc()).toMatchObject({ status: 'pending', claimedAt: null });
    void cur;
  });

  it('drops: sheet gone; already reprocessed with every source; stale claims retried; publish failure → retry later', async () => {
    put({ dependentVersionId: 'vOld' });
    const vp = fsPaths.version(orgId, projectId, sheetId, versionId);
    t.repo.docs.set(vp, { ...(t.repo.docs.get(vp) as Doc), referenceSources: ['arch-p0/v9'] });
    expect(await svc.runDue(now)).toMatchObject({ dropped: 1 });
    expect(reqDoc()).toMatchObject({ status: 'dropped', dropReason: 'already_reprocessed' });
    t.repo.docs.set(vp, { ...(t.repo.docs.get(vp) as Doc), referenceSources: undefined });
    put({ status: 'firing', claimedAt: nowSec - 30 });
    expect(await svc.runDue(now)).toMatchObject({ fired: 0, dropped: 0 }); // fresh claim: someone else is on it
    put({ status: 'firing', claimedAt: nowSec - 601 });
    const pub = t.queue.publish.bind(t.queue);
    t.queue.publish = async () => {
      throw new Error('down');
    };
    try {
      expect(await svc.runDue(now)).toMatchObject({ failed: 1 });
    } finally {
      t.queue.publish = pub;
    }
    expect(reqDoc().status).toBe('pending');
    expect(reqDoc().notBefore).toBeGreaterThan(nowSec + 200);
    t.repo.docs.set(reqPath(), { ...reqDoc(), sheetId: 'gone-p0' });
    t.repo.docs.delete(reqPath());
    t.repo.docs.set(fsPaths.reprocessRequest(orgId, projectId, 'gone-p0'), { sheetId: 'gone-p0', status: 'pending', sources: [], reason: 'reference_walls', firstRequestedAt: nowSec, notBefore: nowSec - 1, updatedAt: nowSec });
    expect(await svc.runDue(now)).toMatchObject({ dropped: 1 });
    expect(t.repo.docs.get(fsPaths.reprocessRequest(orgId, projectId, 'gone-p0'))).toMatchObject({ status: 'dropped', dropReason: 'sheet_gone' });
  });
});
