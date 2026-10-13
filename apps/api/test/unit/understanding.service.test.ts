import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { JOB_TYPES, OVERLAY_MAX_THUMBS, storagePaths } from '@kamutan/contracts';
import { AccessService } from '../../src/access/access.service';
import { ApiException } from '../../src/common/api-exception';
import { InMemoryRepository } from '../../src/db/in-memory.repository';
import { toVersion } from '../../src/db/mappers';
import { InMemoryIngestQueue, type IngestQueue } from '../../src/queue/ingest-queue';
import { SheetsService } from '../../src/sheets/sheets.service';
import { FakeUrlSigner } from '../../src/sheets/url-signer';
import {
  ArtifactTooLargeError,
  assertUnderstandingArtifactPath,
  decodeGzipJson,
  InMemoryArtifactReader,
  MAX_ARTIFACT_JSON_BYTES,
} from '../../src/understanding/artifact-reader';
import { UnderstandingService } from '../../src/understanding/understanding.service';
import { user } from '../support/fake-verifier';

const TRACE = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const SIG = 'd4'.repeat(20);
const box = { x: 0, y: 0, w: 1, h: 1 };

/** Services called directly — no guards — so isolation must hold at the service layer (SEC-09). */
describe('UnderstandingService (in-memory repo, fake signer, in-memory artifacts)', () => {
  let repo: InMemoryRepository;
  let queue: InMemoryIngestQueue;
  let signer: FakeUrlSigner;
  let artifacts: InMemoryArtifactReader;
  let sheets: SheetsService;
  let svc: UnderstandingService;
  let A: string;
  let B: string;
  let pa: string;
  let pb: string;
  let sheetId: string;
  let versionId: string;
  const aEditor = user('aEd');
  const aViewer = user('aVw');
  const bAdmin = user('bAd');

  beforeEach(async () => {
    repo = new InMemoryRepository();
    queue = new InMemoryIngestQueue();
    signer = new FakeUrlSigner('b', 900);
    artifacts = new InMemoryArtifactReader();
    const access = new AccessService(repo);
    sheets = new SheetsService(access, repo, queue, signer);
    svc = new UnderstandingService(access, repo, signer, artifacts, sheets);
    A = repo.seedOrg('A', { aEd: 'editor', aVw: 'viewer' }).id;
    B = repo.seedOrg('B', { bAd: 'admin' }).id;
    pa = (await repo.createProject(A, { name: 'A' }, 'aEd')).id;
    pb = (await repo.createProject(B, { name: 'B' }, 'bAd')).id;
    const sha = '1'.repeat(64);
    await repo.createSheetSetIngest(A, pa, {
      name: 's', sha256: sha, fileKind: 'pdf', storagePath: storagePaths.projectUpload(A, pa, sha, 'pdf'),
      uploadedBy: 'aEd', uploadFileId: 'f', sizeBytes: 1, jobType: JOB_TYPES.ingestSheetVersion,
    });
    ({ sheetId, versionId } = repo.seedWorkerSheet(A, pa, sha, 0, { understanding: true }));
    artifacts.putJson(storagePaths.detections(A, pa, sheetId, versionId), {
      schema: 'kamutan.detections/1',
      detections: [],
      unknownClusters: [{ id: 'u_0', signature: SIG, count: 3, exemplarBboxMm: box, thumb: 'unknown/u_0.webp' }],
    });
    repo.seedLegendEntry(A, pa, `le_${sheetId}_0`, { sheetId, versionId, signature: SIG });
  });

  it('org B admin gets 404 on every Sprint-2 method for org A data (even with the right ids)', async () => {
    const body = { sheetId, versionId, class: 'socket_power' as const, createLegendEntry: true };
    await expect(svc.overlay(bAdmin, pa, sheetId, versionId)).rejects.toMatchObject({ status: 404 });
    await expect(svc.listLegendEntries(bAdmin, pa, { limit: 10 })).rejects.toMatchObject({ status: 404 });
    await expect(svc.patchLegendEntry(bAdmin, pa, `le_${sheetId}_0`, { action: 'confirm' })).rejects.toMatchObject({ status: 404 });
    await expect(svc.resolveUnknownCluster(bAdmin, pa, 'u_0', body, TRACE)).rejects.toMatchObject({ status: 404 });
    // Using their own project id with org A's sheet / entry ids finds nothing in org B.
    await expect(svc.overlay(bAdmin, pb, sheetId, versionId)).rejects.toMatchObject({ status: 404 });
    await expect(svc.patchLegendEntry(bAdmin, pb, `le_${sheetId}_0`, { action: 'confirm' })).rejects.toMatchObject({ status: 404 });
    await expect(svc.resolveUnknownCluster(bAdmin, pb, 'u_0', body, TRACE)).rejects.toMatchObject({ status: 404 });
    expect(await repo.getSymbolMapping(A, SIG)).toBeNull();
    expect(await repo.getSymbolMapping(B, SIG)).toBeNull();
    expect(queue.messages).toHaveLength(0);
  });

  it('viewer may read but not decide or resolve', async () => {
    await expect(svc.overlay(aViewer, pa, sheetId, versionId)).resolves.toMatchObject({ sheetId });
    await expect(svc.listLegendEntries(aViewer, pa, { limit: 10 })).resolves.toMatchObject({ items: [expect.anything()] });
    await expect(svc.patchLegendEntry(aViewer, pa, `le_${sheetId}_0`, { action: 'ignore' })).rejects.toMatchObject({ status: 403 });
    await expect(
      svc.resolveUnknownCluster(aViewer, pa, 'u_0', { sheetId, versionId, class: 'socket_power', createLegendEntry: false }, TRACE),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('a race with another reprocess (409 from the reprocess path) is reported as skipped/in_progress', async () => {
    const racing = new UnderstandingService(new AccessService(repo), repo, signer, artifacts, {
      reprocess: async () => {
        throw new ApiException(409, 'conflict', 'this sheet is already being processed');
      },
    } as unknown as SheetsService);
    const res = await racing.resolveUnknownCluster(aEditor, pa, 'u_0', { sheetId, versionId, class: 'socket_power', createLegendEntry: false }, TRACE);
    expect(res.reprocess).toEqual([{ sheetId, status: 'skipped', reason: 'in_progress', versionId: null, jobId: null }]);
    expect(res.mapping).toMatchObject({ class: 'socket_power', label: 'שקע כח', uses: 1 });
  });

  it('publish failure on reprocess → mapping kept, outcome publish_failed', async () => {
    const down = { publish: async () => { throw new Error('down'); } } as unknown as IngestQueue;
    const failing = new SheetsService(new AccessService(repo), repo, down, signer);
    const s = new UnderstandingService(new AccessService(repo), repo, signer, artifacts, failing);
    const res = await s.resolveUnknownCluster(aEditor, pa, 'u_0', { sheetId, versionId, class: 'socket_power', createLegendEntry: false }, TRACE);
    expect(res.reprocess[0]).toMatchObject({ status: 'skipped', reason: 'publish_failed' });
    expect(await repo.getSymbolMapping(A, SIG)).toMatchObject({ uses: 1 });
  });

  it('overlay caps crops at OVERLAY_MAX_THUMBS (legend rows first) and only signs version-scoped paths', async () => {
    const n = OVERLAY_MAX_THUMBS + 10;
    artifacts.putJson(storagePaths.legend(A, pa, sheetId, versionId), {
      entries: Array.from({ length: n }, (_, i) => ({ id: `le_${sheetId}_${i}`, thumb: `legend/le_${sheetId}_${i}.webp` })),
    });
    const m = await svc.overlay(aViewer, pa, sheetId, versionId);
    expect(Object.keys(m.thumbs)).toHaveLength(OVERLAY_MAX_THUMBS);
    expect(Object.keys(m.thumbs).every((k) => k.startsWith('le_'))).toBe(true);
  });

  it('overlay survives a malformed artifact (no crops, URLs still issued)', async () => {
    artifacts.putJson(storagePaths.legend(A, pa, sheetId, versionId), { entries: [{ id: '../../x', thumb: 'legend/x.webp' }] });
    artifacts.objects.set(storagePaths.detections(A, pa, sheetId, versionId), gzipSync(Buffer.from('{not json')));
    const m = await svc.overlay(aViewer, pa, sheetId, versionId);
    expect(m.thumbs).toEqual({});
    expect(m.legend?.url).toContain('legend.json.gz');
  });
});

describe('artifact reader + signer guards', () => {
  it('reads only the three understanding artifacts under a version prefix', () => {
    const ok = storagePaths.detections('o', 'p', 's', 'v');
    expect(() => assertUnderstandingArtifactPath(ok)).not.toThrow();
    for (const bad of [
      storagePaths.thumbnail('o', 'p', 's', 'v'),
      storagePaths.projectUpload('o', 'p', 's', 'pdf'),
      `${storagePaths.llmCachePrefix('o')}abc.json.gz`,
      'orgs/o/projects/p/sheets/s/versions/v/../../../x/detections.json.gz',
    ]) {
      expect(() => assertUnderstandingArtifactPath(bad), bad).toThrow();
    }
  });

  it('missing object → null; gzip bomb → ArtifactTooLargeError', async () => {
    const r = new InMemoryArtifactReader();
    expect(await r.readJson(storagePaths.rooms('o', 'p', 's', 'v'))).toBeNull();
    const bomb = gzipSync(Buffer.alloc(MAX_ARTIFACT_JSON_BYTES + 1, 0x20));
    expect(() => decodeGzipJson(bomb)).toThrow(ArtifactTooLargeError);
  });

  it('the signer refuses llm-cache objects and foreign thumb names', async () => {
    const s = new FakeUrlSigner();
    await expect(s.signRead([`${storagePaths.llmCachePrefix('o')}k`])).rejects.toThrow();
    await expect(s.signRead(['orgs/o/projects/p/sheets/s/versions/v/legend/u_1.webp'])).rejects.toThrow();
    await expect(s.signRead([storagePaths.unknownThumb('o', 'p', 's', 'v', 'u_1')])).resolves.toBeInstanceOf(Map);
  });
});

describe('version mapper (worker-written Sprint-2 fields)', () => {
  const base = { status: 'ready', progress: { stage: 'rooms', pct: 95 }, artifacts: { legend: 'x', detections: 'y', rooms: 'z' } };
  it('keeps new stages, artifacts and well-formed stats; drops malformed parts without failing', () => {
    const v = toVersion('s', 'v', {
      ...base,
      stats: { paths: 1, segments: 1, textLines: 1, glyphs: 1, detections: { total: -1 }, rooms: 3, legendEntries: 'x' },
    });
    expect(v.progress.stage).toBe('rooms');
    expect(v.artifacts).toMatchObject({ legend: 'x', detections: 'y', rooms: 'z' });
    expect(v.stats).toEqual({ paths: 1, segments: 1, textLines: 1, glyphs: 1, rooms: 3 });
  });
});
