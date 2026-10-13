import { beforeEach, describe, expect, it } from 'vitest';
import { fsPaths, IngestSheetVersionJobSchema, storagePaths, type Region } from '@kamutan/contracts';
import { AccessService } from '../../src/access/access.service';
import { InMemoryRepository } from '../../src/db/in-memory.repository';
import { JobsService } from '../../src/jobs/jobs.service';
import { InMemoryIngestQueue, type IngestQueue } from '../../src/queue/ingest-queue';
import { validateRegions } from '../../src/sheets/region-validation';
import { SheetsService } from '../../src/sheets/sheets.service';
import { CachingUrlSigner, FakeUrlSigner } from '../../src/sheets/url-signer';
import { InMemoryObjectStorage } from '../../src/uploads/storage/in-memory.storage';
import { UploadTokenSigner } from '../../src/uploads/upload-token';
import { UploadsService } from '../../src/uploads/uploads.service';
import { user } from '../support/fake-verifier';
import { SAMPLE, UPLOAD_SECRET } from '../support/helpers';

const TRACE = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const P = (pts: Array<[number, number]>) => pts.map(([x, y]) => ({ x, y }));
const rect = (x0: number, y0: number, x1: number, y1: number) => P([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
const region = (id: string, polygonMm = rect(10, 10, 400, 290), floor = 'ground'): Region => ({ id, floor, polygonMm, scaleDenominator: 50 });

const audits = (repo: InMemoryRepository, orgId: string) =>
  [...repo.docs.entries()].filter(([k]) => k.startsWith(`orgs/${orgId}/auditLog/`)).map(([, v]) => v);

describe('SheetsService / JobsService (in-memory repo, fake signer, in-memory queue)', () => {
  let repo: InMemoryRepository;
  let queue: InMemoryIngestQueue;
  let signer: FakeUrlSigner;
  let sheets: SheetsService;
  let jobs: JobsService;
  let uploads: UploadsService;
  let orgId: string;
  let otherOrg: string;
  let projectId: string;
  let setId: string;
  let jobId: string;
  let versionId: string;
  const editor = user('ed');
  const viewer = user('vw');
  const outsider = user('out');

  const makeSheets = (q: IngestQueue = queue) => new SheetsService(new AccessService(repo), repo, q, signer);

  beforeEach(async () => {
    repo = new InMemoryRepository();
    queue = new InMemoryIngestQueue();
    signer = new FakeUrlSigner('b', 900);
    sheets = makeSheets();
    jobs = new JobsService(new AccessService(repo), repo);
    const storage = new InMemoryObjectStorage();
    uploads = new UploadsService(new AccessService(repo), repo, queue, storage, new UploadTokenSigner(UPLOAD_SECRET));
    orgId = repo.seedOrg('Org', { ed: 'editor', vw: 'viewer' }).id;
    otherOrg = repo.seedOrg('Other', { out: 'admin' }).id;
    projectId = (await repo.createProject(orgId, { name: 'P' }, 'ed')).id;
    // Real finalize, then emulate the worker splitting 3 pages with the set's versionId.
    const up = await uploads.createUpload(editor, projectId, { filename: 'set.pdf', sizeBytes: SAMPLE.pdf.length });
    storage.put(up.storagePath, SAMPLE.pdf);
    const fin = await uploads.finalize(editor, projectId, { uploadToken: up.uploadToken }, TRACE);
    setId = fin.sheetSet.id;
    jobId = fin.jobId;
    versionId = fin.versionId;
    repo.seedWorkerSheet(orgId, projectId, setId, 0, { versionId });
    repo.seedWorkerSheet(orgId, projectId, setId, 1, { versionId, status: 'processing' });
    repo.seedWorkerSheet(orgId, projectId, setId, 10, { versionId, discipline: 'lighting' });
    queue.messages.length = 0;
  });

  describe('list / get version', () => {
    it('lists sheets with classification, confirmed and current version status/progress (viewer)', async () => {
      const page = await sheets.list(viewer, projectId, { limit: 100 });
      expect(page.items.map((s) => s.pageIndex)).toEqual([0, 1, 10]);
      expect(page.items[0]).toMatchObject({
        id: `${setId}-p0`,
        sheetSetId: setId,
        discipline: 'electrical',
        confirmed: false,
        classification: { level: 'yellow' },
        currentVersion: { id: versionId, status: 'ready', progress: { stage: 'done', pct: 100 } },
      });
      expect(page.items[1]?.currentVersion).toMatchObject({ status: 'processing', progress: { stage: 'render', pct: 40 } });
      expect(page.nextCursor).toBeNull();
    });

    it('paginates by sheet id and filters by sheetSetId', async () => {
      const p1 = await sheets.list(viewer, projectId, { limit: 2 });
      expect(p1.items).toHaveLength(2);
      const p2 = await sheets.list(viewer, projectId, { limit: 2, cursor: p1.nextCursor as string });
      expect(p2.items).toHaveLength(1);
      expect(p2.nextCursor).toBeNull();
      expect(new Set([...p1.items, ...p2.items].map((s) => s.id)).size).toBe(3);
      expect((await sheets.list(viewer, projectId, { limit: 10, sheetSetId: 'nope' })).items).toEqual([]);
    });

    it('returns a version; 404 for unknown/malformed ids and for other orgs', async () => {
      const v = await sheets.getVersion(viewer, projectId, `${setId}-p0`, versionId);
      expect(v).toMatchObject({ status: 'ready', page: { widthMm: 841, heightMm: 594 }, artifacts: { tiles: { tileSize: 256, levels: 7 } } });
      await expect(sheets.getVersion(viewer, projectId, `${setId}-p0`, 'nope')).rejects.toMatchObject({ status: 404 });
      await expect(sheets.getVersion(viewer, projectId, '../x', versionId)).rejects.toMatchObject({ status: 404 });
      await expect(sheets.getVersion(outsider, projectId, `${setId}-p0`, versionId)).rejects.toMatchObject({ status: 404 });
      await expect(sheets.list(outsider, projectId, { limit: 10 })).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('confirm', () => {
    it('writes confirmed fields + audit (editor); viewer 403; outsider 404', async () => {
      const sid = `${setId}-p0`;
      const res = await sheets.confirm(editor, projectId, sid, { discipline: 'lighting', floors: ['first'], scaleDenominator: 100 });
      expect(res).toMatchObject({ discipline: 'lighting', floors: ['first'], scaleDenominator: 100, confirmed: true, confirmedBy: 'ed' });
      expect(res.confirmedAt).toBeTruthy();
      expect(repo.docs.get(fsPaths.sheet(orgId, projectId, sid))).toMatchObject({ confirmed: true, discipline: 'lighting' });
      const last = audits(repo, orgId).at(-1);
      expect(last).toMatchObject({ action: 'confirm', entity: 'sheets', entityId: sid, actorId: 'ed', after: { discipline: 'lighting', regionCount: null } });
      await expect(sheets.confirm(viewer, projectId, sid, { discipline: 'x', floors: [], scaleDenominator: null })).rejects.toMatchObject({ status: 403 });
      await expect(sheets.confirm(outsider, projectId, sid, { discipline: 'x', floors: [], scaleDenominator: null })).rejects.toMatchObject({ status: 404 });
      await expect(sheets.confirm(editor, projectId, `${setId}-p99`, { discipline: 'x', floors: [], scaleDenominator: null })).rejects.toMatchObject({ status: 404 });
    });

    it('with regions: validates against the page and stores them on the current version', async () => {
      const sid = `${setId}-p0`;
      await sheets.confirm(editor, projectId, sid, { discipline: 'electrical', floors: ['ground'], scaleDenominator: 50, regions: [region('r1')] });
      expect(repo.docs.get(fsPaths.version(orgId, projectId, sid, versionId))?.regions).toEqual([region('r1')]);
      await expect(
        sheets.confirm(editor, projectId, sid, { discipline: 'electrical', floors: [], scaleDenominator: 50, regions: [region('r1', rect(0, 0, 900, 100))] }),
      ).rejects.toMatchObject({ status: 400, code: 'validation_failed' });
    });
  });

  describe('regions', () => {
    const sid = () => `${setId}-p0`;

    it('replaces regions of the current version + audit', async () => {
      const res = await sheets.putRegions(editor, projectId, sid(), [region('a', rect(0, 0, 420, 594)), region('b', rect(420, 0, 841, 594), 'first')]);
      expect(res).toMatchObject({ sheetId: sid(), versionId, regions: [{ id: 'a' }, { id: 'b', floor: 'first' }] });
      expect(audits(repo, orgId).at(-1)).toMatchObject({ action: 'set_regions', entity: 'sheetVersions', entityId: versionId });
      const cleared = await sheets.putRegions(editor, projectId, sid(), []);
      expect(cleared.regions).toEqual([]);
    });

    it('rejects out-of-page points, self-intersections and tiny polygons with issue paths', async () => {
      const bowtie = P([[10, 10], [100, 100], [100, 10], [10, 100]]);
      await expect(sheets.putRegions(editor, projectId, sid(), [region('a', rect(-5, 0, 10, 10))])).rejects.toMatchObject({
        status: 400,
        issues: [expect.objectContaining({ path: 'regions.0.polygonMm.0' })],
      });
      await expect(sheets.putRegions(editor, projectId, sid(), [region('a'), region('b', bowtie)])).rejects.toMatchObject({
        status: 400,
        issues: [{ path: 'regions.1.polygonMm', message: 'polygon must not self-intersect' }],
      });
      await expect(sheets.putRegions(editor, projectId, sid(), [region('a', P([[0, 0], [0.5, 0], [0, 0.5]]))])).rejects.toMatchObject({ status: 400 });
      // Points exactly on the page edge are fine.
      await expect(sheets.putRegions(editor, projectId, sid(), [region('a', rect(0, 0, 841, 594))])).resolves.toBeTruthy();
    });

    it('409 when the page geometry is unknown; 403 viewer; 404 other org', async () => {
      const { sheetId } = repo.seedWorkerSheet(orgId, projectId, setId, 5, { status: 'queued' });
      const doc = repo.docs.get(fsPaths.version(orgId, projectId, sheetId, (repo.docs.get(fsPaths.sheet(orgId, projectId, sheetId))?.currentVersionId as string)));
      if (doc) doc.page = null;
      await expect(sheets.putRegions(editor, projectId, sheetId, [region('a')])).rejects.toMatchObject({ status: 409, code: 'not_ready' });
      await expect(sheets.putRegions(viewer, projectId, sid(), [])).rejects.toMatchObject({ status: 403 });
      await expect(sheets.putRegions(outsider, projectId, sid(), [])).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('tiles manifest', () => {
    const sid = () => `${setId}-p0`;

    it('meta only without z: level grid + thumbnail, no tile URLs', async () => {
      const m = await sheets.tilesManifest(viewer, projectId, sid(), versionId, {});
      expect(m.tiles).toEqual({ format: 'webp', tileSize: 256, dpi: 300, levels: 7, widthPx: 9933, heightPx: 7016 });
      expect(m.levelGrid[0]).toMatchObject({ z: 0, cols: 1, rows: 1 });
      expect(m.levelGrid[6]).toMatchObject({ z: 6, widthPx: 9933, heightPx: 7016, cols: 39, rows: 28 });
      expect(m.thumbnailUrl).toContain(encodeURI(storagePaths.thumbnail(orgId, projectId, sid(), versionId)));
      expect(m.urls).toEqual({});
      expect(m.maxBatch).toBe(256);
      expect(Date.parse(m.expiresAt) - Date.now()).toBeGreaterThan(14 * 60_000);
      expect(Date.parse(m.expiresAt) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    });

    it('signs a clamped window keyed z/x_y; whole level when it fits', async () => {
      const m = await sheets.tilesManifest(viewer, projectId, sid(), versionId, { z: 6, x0: 37, x1: 50, y0: 26, y1: 30 });
      // cols=39 rows=28 → x 37..38, y 26..27
      expect(Object.keys(m.urls).sort()).toEqual(['6/37_26', '6/37_27', '6/38_26', '6/38_27']);
      expect(m.urls['6/38_27']).toContain(encodeURI(storagePaths.tile(orgId, projectId, sid(), versionId, 6, 38, 27)));
      const whole = await sheets.tilesManifest(viewer, projectId, sid(), versionId, { z: 2 });
      expect(Object.keys(whole.urls)).toHaveLength(m.levelGrid[2]!.cols * m.levelGrid[2]!.rows);
    });

    it('caps a batch at 256 URLs and rejects z beyond the pyramid', async () => {
      const ok = await sheets.tilesManifest(viewer, projectId, sid(), versionId, { z: 6, x0: 0, x1: 15, y0: 0, y1: 15 });
      expect(Object.keys(ok.urls)).toHaveLength(256);
      await expect(sheets.tilesManifest(viewer, projectId, sid(), versionId, { z: 6, x0: 0, x1: 16, y0: 0, y1: 15 })).rejects.toMatchObject({ status: 400 });
      await expect(sheets.tilesManifest(viewer, projectId, sid(), versionId, { z: 6 })).rejects.toMatchObject({ status: 400 });
      await expect(sheets.tilesManifest(viewer, projectId, sid(), versionId, { z: 7 })).rejects.toMatchObject({ status: 400 });
    });

    it('409 while not ready; 404 for other orgs and unknown versions', async () => {
      await expect(sheets.tilesManifest(viewer, projectId, `${setId}-p1`, versionId, {})).rejects.toMatchObject({ status: 409, code: 'not_ready' });
      await expect(sheets.tilesManifest(outsider, projectId, sid(), versionId, {})).rejects.toMatchObject({ status: 404 });
      await expect(sheets.tilesManifest(viewer, projectId, sid(), 'nope', {})).rejects.toMatchObject({ status: 404 });
      expect(signer.signed).toBe(0);
    });

    it('never signs a worker-written prefix: paths are derived from the ids', async () => {
      const vdoc = repo.docs.get(fsPaths.version(orgId, projectId, sid(), versionId)) as { artifacts: { tiles: { prefix: string } } };
      vdoc.artifacts.tiles.prefix = `orgs/${otherOrg}/projects/x/sheets/y/versions/z/tiles/`;
      const m = await sheets.tilesManifest(viewer, projectId, sid(), versionId, { z: 0 });
      expect(m.urls['0/0_0']).toContain(`orgs/${orgId}/projects/${projectId}/`);
      expect(JSON.stringify(m)).not.toContain(otherOrg);
    });
  });

  describe('reprocess', () => {
    const sid = () => `${setId}-p0`;

    it('creates a queued version (regions carried over), a job, switches current, publishes v3 + audit', async () => {
      await sheets.putRegions(editor, projectId, sid(), [region('r1')]);
      const res = await sheets.reprocess(editor, projectId, sid(), TRACE);
      expect(res.sheetVersion).toMatchObject({ status: 'queued', versionNo: 2, regions: [region('r1')], progress: { stage: 'ingest', pct: 0 }, jobId: res.jobId });
      expect(res.sheet.currentVersionId).toBe(res.sheetVersion.id);
      expect(repo.docs.get(fsPaths.sheet(orgId, projectId, sid()))?.currentVersionId).toBe(res.sheetVersion.id);
      expect(repo.docs.get(fsPaths.job(res.jobId))).toMatchObject({ orgId, projectId, sheetSetId: setId, sheetId: sid(), versionId: res.sheetVersion.id, status: 'queued' });
      expect(IngestSheetVersionJobSchema.parse(queue.messages[0]?.data)).toMatchObject({
        schemaVersion: 3,
        jobId: res.jobId,
        sheetSetId: setId,
        sheetId: sid(),
        pageIndex: 0,
        versionId: res.sheetVersion.id,
        storagePath: storagePaths.projectUpload(orgId, projectId, setId, 'pdf'),
      });
      expect(queue.messages[0]?.attributes).toMatchObject({ orgId, type: 'ingest.sheet_version' });
      expect(audits(repo, orgId).at(-1)).toMatchObject({ action: 'reprocess', entityId: sid(), after: { previousVersionId: versionId, versionId: res.sheetVersion.id } });
    });

    it('409 while the current version is queued/processing', async () => {
      await sheets.reprocess(editor, projectId, sid(), TRACE);
      await expect(sheets.reprocess(editor, projectId, sid(), TRACE)).rejects.toMatchObject({ status: 409, code: 'conflict' });
      await expect(sheets.reprocess(editor, projectId, `${setId}-p1`, TRACE)).rejects.toMatchObject({ status: 409 });
      expect(queue.messages).toHaveLength(1);
    });

    it('publish failure → 503, version + job marked failed (so a retry is allowed)', async () => {
      const failing = makeSheets({ publish: async () => Promise.reject(new Error('down')), ping: async () => undefined, close: async () => undefined });
      await expect(failing.reprocess(editor, projectId, sid(), TRACE)).rejects.toMatchObject({ status: 503 });
      const cur = repo.docs.get(fsPaths.sheet(orgId, projectId, sid()))?.currentVersionId as string;
      expect(repo.docs.get(fsPaths.version(orgId, projectId, sid(), cur))).toMatchObject({ status: 'failed', error: { code: 'publish_failed' } });
      await expect(sheets.reprocess(editor, projectId, sid(), TRACE)).resolves.toMatchObject({ sheetVersion: { versionNo: 3 } });
    });

    it('viewer 403, outsider 404, unknown sheet 404', async () => {
      await expect(sheets.reprocess(viewer, projectId, sid(), TRACE)).rejects.toMatchObject({ status: 403 });
      await expect(sheets.reprocess(outsider, projectId, sid(), TRACE)).rejects.toMatchObject({ status: 404 });
      await expect(sheets.reprocess(editor, projectId, 'nope', TRACE)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('jobs', () => {
    it('members of job.orgId can read it (progress normalised); others get 404', async () => {
      await expect(jobs.get(viewer, jobId)).resolves.toMatchObject({ id: jobId, orgId, sheetSetId: setId, sheetId: null, status: 'queued', progress: { stage: 'ingest', pct: 0 }, attempts: 0 });
      await expect(jobs.get(outsider, jobId)).rejects.toMatchObject({ status: 404 });
      await expect(jobs.get(viewer, 'missing')).rejects.toMatchObject({ status: 404 });
      await expect(jobs.get(viewer, '../orgs')).rejects.toMatchObject({ status: 404 });
    });

    it('tolerates worker docs with numeric progress + stage', async () => {
      const d = repo.docs.get(fsPaths.job(jobId)) as Record<string, unknown>;
      repo.docs.set(fsPaths.job(jobId), { ...d, status: 'running', progress: 45, stage: 'render', attempts: 2 });
      await expect(jobs.get(viewer, jobId)).resolves.toMatchObject({ status: 'running', progress: { stage: 'render', pct: 45 }, attempts: 2 });
    });
  });
});

describe('validateRegions', () => {
  const page = { widthMm: 100, heightMm: 50, rotation: 0 as const };
  it('accepts concave simple polygons on the page', () => {
    expect(validateRegions([region('a', P([[0, 0], [100, 0], [100, 50], [50, 20], [0, 50]]))], page)).toEqual([]);
  });
  it('flags each problem with a path', () => {
    const issues = validateRegions([region('a', rect(0, 0, 101, 10)), region('b', P([[0, 0], [10, 10], [10, 0], [0, 10]]))], page);
    expect(issues.map((i) => i.path)).toEqual(['regions.0.polygonMm.1', 'regions.1.polygonMm']);
  });
});

describe('CachingUrlSigner', () => {
  it('reuses URLs while >= minRemaining is left, re-signs after', async () => {
    let now = 1_000_000;
    const inner = new FakeUrlSigner('b', 900, () => now);
    const cache = new CachingUrlSigner(inner, 600_000, 10, () => now);
    const a = storagePaths.tile('o', 'p', 's', 'v', 0, 0, 0);
    const b = storagePaths.tile('o', 'p', 's', 'v', 0, 1, 0);
    const first = await cache.signRead([a, b]);
    expect(inner.signed).toBe(2);
    now += 299_000; // 601s left
    const second = await cache.signRead([a]);
    expect(inner.signed).toBe(2);
    expect(second.get(a)?.url).toBe(first.get(a)?.url);
    now += 2_000; // 599s left → re-sign
    await cache.signRead([a, b]);
    expect(inner.signed).toBe(4);
  });

  it('refuses to sign anything that is not a version artifact', async () => {
    const cache = new CachingUrlSigner(new FakeUrlSigner(), 1000);
    await expect(cache.signRead(['orgs/o/projects/p/uploads/s/source.pdf'])).rejects.toThrow();
    await expect(cache.signRead(['orgs/o/quarantine/x'])).rejects.toThrow();
  });
});
