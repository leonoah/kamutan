/**
 * Integration tests against the Firebase emulators (run in CI):
 *   pnpm --filter @kamutan/api test:emulator
 *   (= firebase emulators:exec --only firestore,storage,pubsub --project demo-kamutan "vitest run test/integration")
 * Skipped when FIRESTORE_EMULATOR_HOST is unset (emulator downloads are blocked in the dev sandbox).
 * Storage / Pub/Sub parts additionally need FIREBASE_STORAGE_EMULATOR_HOST / PUBSUB_EMULATOR_HOST.
 */
import { randomUUID } from 'node:crypto';
import { PubSub } from '@google-cloud/pubsub';
import { DEFAULT_BOQ_RULES, fsPaths, itemIdFor, JOB_TYPES, storagePaths } from '@kamutan/contracts';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessService } from '../../src/access/access.service';
import { auditHash } from '../../src/db/audit-chain';
import { FirestoreRepository } from '../../src/db/firestore.repository';
import { FirestoreBoqRepository } from '../../src/db/boq-firestore.repository';
import { RepoConflictError } from '../../src/db/repository';
import { JobsService } from '../../src/jobs/jobs.service';
import { InMemoryIngestQueue, PubSubIngestQueue } from '../../src/queue/ingest-queue';
import { ProjectsService } from '../../src/projects/projects.service';
import { SheetsService } from '../../src/sheets/sheets.service';
import { FakeUrlSigner } from '../../src/sheets/url-signer';
import { FirebaseObjectStorage } from '../../src/uploads/storage/firebase.storage';
import type { ObjectStorage } from '../../src/uploads/storage/object-storage';
import { UploadTokenSigner } from '../../src/uploads/upload-token';
import { UploadsService } from '../../src/uploads/uploads.service';
import { InMemoryArtifactReader } from '../../src/understanding/artifact-reader';
import { UnderstandingService } from '../../src/understanding/understanding.service';
import { user } from '../support/fake-verifier';
import { SAMPLE, UPLOAD_SECRET } from '../support/helpers';

const PROJECT = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? 'demo-kamutan';
const BUCKET = `${PROJECT}.appspot.com`;
const hasFirestore = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const hasStorage = Boolean(process.env.FIREBASE_STORAGE_EMULATOR_HOST);
const hasPubSub = Boolean(process.env.PUBSUB_EMULATOR_HOST);
const TRACE = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe.skipIf(!hasFirestore)('FirestoreRepository + services on the Firestore emulator', () => {
  let app: App;
  let db: Firestore;
  let repo: FirestoreRepository;
  let access: AccessService;
  let projects: ProjectsService;
  const run = randomUUID().slice(0, 8);
  const uid = (n: string) => `${n}_${run}`;
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    app = initializeApp({ projectId: PROJECT, storageBucket: BUCKET }, `it-${run}`);
    db = getFirestore(app);
    repo = new FirestoreRepository(db);
    access = new AccessService(repo);
    projects = new ProjectsService(access, repo);
    orgA = (await repo.createOrgWithAdmin('Org A', { uid: uid('aAdmin') })).id;
    orgB = (await repo.createOrgWithAdmin('Org B', { uid: uid('bAdmin') })).id;
    // Admin-managed memberships (no invite API yet).
    await db.doc(fsPaths.member(orgA, uid('aEditor'))).set({ uid: uid('aEditor'), role: 'editor', createdAt: new Date() });
    await db.doc(fsPaths.member(orgA, uid('aViewer'))).set({ uid: uid('aViewer'), role: 'viewer', createdAt: new Date() });
  });

  afterAll(async () => {
    if (app) await deleteApp(app);
  });

  it('createOrgWithAdmin writes orgs/{id}, members/{uid} and a chained audit event', async () => {
    expect((await db.doc(fsPaths.org(orgA)).get()).get('settings')).toMatchObject({ llmEnabled: false });
    expect((await db.doc(fsPaths.member(orgA, uid('aAdmin'))).get()).data()).toMatchObject({ uid: uid('aAdmin'), role: 'admin' });
    const audit = await db.collection(`orgs/${orgA}/auditLog`).get();
    expect(audit.docs.map((d) => d.get('action'))).toEqual(['create']);
    expect(audit.docs[0]?.get('prevHash')).toBeNull();
  });

  it('collection-group lookups: memberships of a uid, project → org', async () => {
    expect(await repo.listMembershipsOf(uid('aViewer'))).toEqual([{ orgId: orgA, role: 'viewer' }]);
    const p = await projects.create(user(uid('aEditor')), { orgId: orgA, name: 'בית נח' });
    expect(await repo.findProjectOrgId(p.id)).toBe(orgA);
    expect(await repo.findProjectOrgId('missing')).toBeNull();
  });

  it('service layer rejects cross-org access against real Firestore', async () => {
    const p = await projects.create(user(uid('aEditor')), { orgId: orgA, name: 'secret' });
    await expect(projects.get(user(uid('bAdmin')), p.id)).rejects.toMatchObject({ status: 404 });
    await expect(projects.update(user(uid('bAdmin')), p.id, { name: 'x' })).rejects.toMatchObject({ status: 404 });
    await expect(projects.create(user(uid('bAdmin')), { orgId: orgA, name: 'x' })).rejects.toMatchObject({ status: 404 });
    await expect(projects.create(user(uid('aViewer')), { orgId: orgA, name: 'x' })).rejects.toMatchObject({ status: 403 });
    expect((await repo.getProject(orgA, p.id))?.name).toBe('secret');
    expect(await repo.getProject(orgB, p.id)).toBeNull(); // wrong org path → nothing
  });

  it('cursor pagination over orgs/{orgId}/projects', async () => {
    const org = (await repo.createOrgWithAdmin('Paging', { uid: uid('pager') })).id;
    for (let i = 0; i < 5; i++) await repo.createProject(org, { name: `P${i}` }, uid('pager'));
    const p1 = await repo.listProjects(org, { limit: 3 });
    const p2 = await repo.listProjects(org, { limit: 3, cursor: p1.nextCursor ?? undefined });
    expect(p1.items).toHaveLength(3);
    expect(p2.items).toHaveLength(2);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((p) => p.id)).size).toBe(5);
  });

  it('createSheetSetIngest is atomic and dedupes concurrent finalizations of the same sha256', async () => {
    const p = await repo.createProject(orgA, { name: 'race' }, uid('aEditor'));
    const sha = 'e'.repeat(64);
    const input = {
      name: 'a.pdf',
      sha256: sha,
      fileKind: 'pdf' as const,
      storagePath: storagePaths.projectUpload(orgA, p.id, sha, 'pdf'),
      uploadedBy: uid('aEditor'),
      uploadFileId: randomUUID(),
      sizeBytes: 10,
      jobType: 'ingest.sheet_version',
    };
    const results = await Promise.all([1, 2, 3].map(() => repo.createSheetSetIngest(orgA, p.id, input)));
    expect(results.filter((r) => !r.deduplicated)).toHaveLength(1);
    expect(new Set(results.map((r) => r.sheetSet.ingestJobId)).size).toBe(1);
    expect((await db.collection(`orgs/${orgA}/projects/${p.id}/sheetSets`).get()).size).toBe(1);
    expect((await db.collection(`orgs/${orgA}/projects/${p.id}/sheets`).get()).size).toBe(0); // worker creates sheets
    const set = results[0]?.sheetSet;
    expect((await db.doc(fsPaths.job(set?.ingestJobId as string)).get()).data()).toMatchObject({
      orgId: orgA,
      projectId: p.id,
      sheetSetId: sha,
      sheetId: null,
      versionId: set?.versionId,
      status: 'queued',
      progress: { stage: 'ingest', pct: 0 },
      attempts: 0,
    });
    expect((await repo.findSheetSetByUploadFileId(orgA, p.id, input.uploadFileId))?.id).toBe(sha);
    await repo.setSheetSetStatus(orgA, p.id, sha, 'queued');
    expect((await repo.getSheetSet(orgA, p.id, sha))?.status).toBe('queued');
  });

  describe('sheets, regions, confirm, reprocess, jobs (worker docs written directly)', () => {
    const sha = 'd'.repeat(64);
    let pid: string;
    const sid = `${sha}-p0`;
    const vid = 'v1';
    const sheets = () => new SheetsService(access, repo, queue, new FakeUrlSigner());
    const jobs = () => new JobsService(access, repo);
    const queue = new InMemoryIngestQueue();
    const region = { id: 'r1', floor: 'ground', polygonMm: [{ x: 10, y: 10 }, { x: 300, y: 10 }, { x: 300, y: 200 }], scaleDenominator: 50 };

    beforeAll(async () => {
      pid = (await repo.createProject(orgA, { name: 'sheets' }, uid('aEditor'))).id;
      await repo.createSheetSetIngest(orgA, pid, {
        name: 'set.pdf',
        sha256: sha,
        fileKind: 'pdf',
        storagePath: storagePaths.projectUpload(orgA, pid, sha, 'pdf'),
        uploadedBy: uid('aEditor'),
        uploadFileId: randomUUID(),
        sizeBytes: 10,
        jobType: 'ingest.sheet_version',
      });
      // What the worker writes after splitting/processing (Timestamps, nested maps — no nested arrays).
      const now = Timestamp.now();
      await db.doc(fsPaths.sheet(orgA, pid, sid)).set({
        sheetSetId: sha, pageIndex: 0, title: 'חשמל', discipline: 'electrical', floors: ['ground'], scaleDenominator: 50,
        classification: { discipline: 'electrical', floors: ['ground'], sheetTitle: 'חשמל', scaleText: '1:50', confidence: 0.9, level: 'yellow', reasons: [] },
        confirmed: false, currentVersionId: vid, updatedAt: now,
      });
      await db.doc(fsPaths.version(orgA, pid, sid, vid)).set({
        versionNo: 1, status: 'ready', progress: { stage: 'done', pct: 100 }, page: { widthMm: 841, heightMm: 594, rotation: 0 },
        artifacts: {
          tiles: { prefix: storagePaths.tilesPrefix(orgA, pid, sid, vid), format: 'webp', tileSize: 256, dpi: 300, levels: 7, widthPx: 9933, heightPx: 7016 },
          thumbnail: storagePaths.thumbnail(orgA, pid, sid, vid),
        },
        regions: [], stats: { paths: 1, segments: 1, textLines: 1, glyphs: 1 }, workerVersion: 'it', updatedAt: now,
      });
    });

    it('lists sheets with their current version (getAll) and reads versions', async () => {
      const page = await sheets().list(user(uid('aViewer')), pid, { limit: 10 });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({ id: sid, confirmed: false, currentVersion: { id: vid, status: 'ready' } });
      expect(page.items[0]?.updatedAt).toMatch(/Z$/);
      await expect(sheets().list(user(uid('bAdmin')), pid, { limit: 10 })).rejects.toMatchObject({ status: 404 });
      expect((await sheets().list(user(uid('aViewer')), pid, { limit: 10, sheetSetId: sha })).items).toHaveLength(1);
    });

    it('stores regions as maps (Firestore has no nested arrays) and confirms in a transaction with audit', async () => {
      await sheets().putRegions(user(uid('aEditor')), pid, sid, [region]);
      expect((await db.doc(fsPaths.version(orgA, pid, sid, vid)).get()).get('regions')).toEqual([region]);
      const res = await sheets().confirm(user(uid('aEditor')), pid, sid, { discipline: 'lighting', floors: ['first'], scaleDenominator: 100 });
      expect(res).toMatchObject({ confirmed: true, discipline: 'lighting', confirmedBy: uid('aEditor') });
      const snap = await db.doc(fsPaths.sheet(orgA, pid, sid)).get();
      expect(snap.get('confirmedAt')).toBeInstanceOf(Timestamp);
      const actions = (await db.collection(`orgs/${orgA}/auditLog`).get()).docs.map((d) => d.get('action'));
      expect(actions).toEqual(expect.arrayContaining(['set_regions', 'confirm']));
    });

    it('tiles manifest signs only this org/version paths', async () => {
      const m = await sheets().tilesManifest(user(uid('aViewer')), pid, sid, vid, { z: 0 });
      expect(Object.keys(m.urls)).toEqual(['0/0_0']);
      expect(m.urls['0/0_0']).toContain(`orgs/${orgA}/projects/${pid}/sheets/${sid}/versions/${vid}/tiles/0/0_0.webp`);
    });

    it('reprocess creates version + job atomically, refuses while in flight; jobs readable by members only', async () => {
      const r = await sheets().reprocess(user(uid('aEditor')), pid, sid, TRACE);
      expect(r.sheetVersion).toMatchObject({ status: 'queued', versionNo: 2, regions: [region] });
      expect((await db.doc(fsPaths.sheet(orgA, pid, sid)).get()).get('currentVersionId')).toBe(r.sheetVersion.id);
      await expect(sheets().reprocess(user(uid('aEditor')), pid, sid, TRACE)).rejects.toMatchObject({ status: 409 });
      await expect(jobs().get(user(uid('aViewer')), r.jobId)).resolves.toMatchObject({ orgId: orgA, sheetId: sid, status: 'queued' });
      await expect(jobs().get(user(uid('bAdmin')), r.jobId)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('Sprint 2: legend entries + symbol mappings (transactions)', () => {
    const SIG = 'e5'.repeat(20);
    let pid: string;
    const sid = 'set2-p0';
    const vid = 'v1';
    const eid = `le_${sid}_0`;
    const svc = () => {
      const signer = new FakeUrlSigner();
      return new UnderstandingService(access, repo, signer, new InMemoryArtifactReader(), new SheetsService(access, repo, new InMemoryIngestQueue(), signer));
    };

    beforeAll(async () => {
      pid = (await repo.createProject(orgA, { name: 'legend' }, uid('aEditor'))).id;
      const now = Timestamp.now();
      for (const n of [0, 1]) {
        await db.doc(fsPaths.legendEntry(orgA, pid, `le_${sid}_${n}`)).set({
          sheetId: sid, versionId: vid, label: 'שקע כפול', labelConfidence: 0.9, suggestedClass: 'socket_double', class: null,
          itemCode: null, signature: SIG, thumbPath: storagePaths.legendThumb(orgA, pid, sid, vid, `le_${sid}_${n}`), status: 'suggested', updatedAt: now,
        });
      }
    });

    it('lists with status filter (equality + document-id order) and signs crops', async () => {
      const page = await svc().listLegendEntries(user(uid('aViewer')), pid, { limit: 1, status: 'suggested' });
      expect(page.items.map((e) => e.id)).toEqual([eid]);
      expect(page.nextCursor).toBe(eid);
      expect(page.items[0]?.thumbUrl).toContain(`/orgs/${orgA}/`);
      await expect(svc().listLegendEntries(user(uid('bAdmin')), pid, { limit: 1 })).rejects.toMatchObject({ status: 404 });
    });

    it('confirm twice on one signature upserts the org mapping with uses++ and audits each decision', async () => {
      await svc().patchLegendEntry(user(uid('aEditor')), pid, eid, { action: 'confirm', itemCode: '08.010' });
      const r = await svc().patchLegendEntry(user(uid('aEditor')), pid, `le_${sid}_1`, { action: 'reassign', class: 'socket_power' });
      expect(r.mapping).toMatchObject({ signature: SIG, class: 'socket_power', uses: 2 });
      const m = await db.doc(fsPaths.symbolMapping(orgA, SIG)).get();
      expect(m.get('confirmedAt')).toBeInstanceOf(Timestamp);
      expect(Object.keys(m.data() ?? {}).sort()).toEqual(['class', 'confirmedAt', 'confirmedBy', 'ignored', 'itemCode', 'label', 'uses']);
      const e = await db.doc(fsPaths.legendEntry(orgA, pid, eid)).get();
      expect(e.data()).toMatchObject({ status: 'confirmed', class: 'socket_double', itemCode: '08.010', confirmedBy: uid('aEditor') });
      const actions = (await db.collection(`orgs/${orgA}/auditLog`).where('entity', '==', 'legendEntries').get()).docs.map((d) => d.get('action'));
      expect(actions.sort()).toEqual(['confirm', 'reassign']);
      await expect(svc().patchLegendEntry(user(uid('bAdmin')), pid, eid, { action: 'ignore' })).rejects.toMatchObject({ status: 404 });
    });
  });

  it('audit log forms a verifiable hash chain', async () => {
    const snap = await db.collection(`orgs/${orgA}/auditLog`).orderBy('at').get();
    let prev: string | null = null;
    for (const d of snap.docs) {
      const { prevHash, hash, at, ...rest } = d.data();
      expect(prevHash).toBe(prev);
      expect(hash).toBe(auditHash(prev, { ...rest, at: at.toDate().toISOString() }));
      prev = hash as string;
    }
    expect(snap.size).toBeGreaterThan(2);
  });

  describe('Sprint 3: BOQ repository (transactions, audit, dedupe)', () => {
    let boq: FirestoreBoqRepository;
    let pid: string;
    beforeAll(async () => {
      boq = new FirestoreBoqRepository(repo);
      pid = (await repo.createProject(orgA, { name: 'BOQ' }, uid('aEditor'))).id;
    });

    it('seedDefaults is create-if-missing and keeps admin edits', async () => {
      expect(await boq.seedDefaults(orgA)).toEqual({ templates: 1, rules: DEFAULT_BOQ_RULES.length });
      await boq.patchRule(orgA, 'r_socket_single', { enabled: false }, uid('aAdmin'));
      expect(await boq.seedDefaults(orgA)).toEqual({ templates: 0, rules: 0 });
      expect((await boq.listRules(orgA)).find((r) => r.id === 'r_socket_single')?.enabled).toBe(false);
      expect((await boq.listTemplates(orgA)).find((t) => t.id === 'tpl_default')?.default).toBe(true);
    });

    it('requestBuild: build + job + project.boq (dotted fields), dedupe, failBuild clears pending', async () => {
      const r1 = await boq.requestBuild(orgA, pid, uid('aEditor'), JOB_TYPES.boqBuild);
      expect(r1?.deduplicated).toBe(false);
      const r2 = await boq.requestBuild(orgA, pid, uid('aEditor'), JOB_TYPES.boqBuild);
      expect(r2).toMatchObject({ deduplicated: true, build: { id: r1?.build.id } });
      const job = (await db.doc(fsPaths.job(r1?.jobId as string)).get()).data();
      expect(job).toMatchObject({ orgId: orgA, projectId: pid, buildId: r1?.build.id, type: 'boq.build', status: 'queued' });
      expect((await repo.getProject(orgA, pid))?.boq).toMatchObject({ pendingBuildId: r1?.build.id, stale: true, latestBuildId: null });
      await boq.failBuild(orgA, pid, r1?.build.id as string, r1?.jobId as string, { code: 'publish_failed', message: 'x' });
      expect((await repo.getProject(orgA, pid))?.boq?.pendingBuildId).toBeNull();
      expect((await boq.getBuild(orgA, pid, r1?.build.id as string))?.status).toBe('failed');
      expect(await boq.requestBuild(orgB, pid, uid('bAdmin'), JOB_TYPES.boqBuild)).toBeNull(); // not B's project
    });

    it('patchLine: transaction + audit chain; state machine; markStale merges into boq', async () => {
      await db.doc(fsPaths.boqLine(orgA, pid, 'l1')).set({ chapter: '04', code: '4.10', description: 'x', qty: 2, unit: 'יחידה', level: 'yellow', status: 'draft', byFloor: { 'קומת קרקע': 2 }, computedAt: Timestamp.now() });
      const l = await boq.patchLine(orgA, pid, 'l1', { status: 'reviewed' }, uid('aEditor'));
      expect(l).toMatchObject({ status: 'reviewed', reviewedBy: uid('aEditor'), code: '4.10', byFloor: { 'קומת קרקע': 2 } });
      expect(typeof l?.reviewedAt).toBe('string');
      await expect(boq.patchLine(orgA, pid, 'l1', { status: 'draft' }, uid('aEditor'))).resolves.toMatchObject({ status: 'draft', reviewedBy: null });
      await expect(boq.patchLine(orgA, pid, 'l1', { status: 'approved' }, uid('aEditor'))).rejects.toBeInstanceOf(RepoConflictError);
      expect(await boq.patchLine(orgB, pid, 'l1', { status: 'reviewed' }, uid('bAdmin'))).toBeNull();
      const log = await db.collection(`orgs/${orgA}/auditLog`).orderBy('at', 'desc').limit(1).get();
      expect(log.docs[0]?.data()).toMatchObject({ entity: 'boqLines', entityId: 'l1', action: 'update' });
      await boq.markStale(orgA, pid, 'legend');
      expect((await repo.getProject(orgA, pid))?.boq).toMatchObject({ stale: true, staleReason: 'legend' });
      await boq.markStale(orgA, 'missing-project', 'legend'); // no throw
      expect(await boq.markOrgStale(orgA, 'rule')).toBeGreaterThan(0);
    });

    it('library item create / conflict / patch; import queue; export record', async () => {
      const id = itemIdFor('4.10', 'x');
      await boq.createLibraryItem(orgA, { id, code: '4.10', chapter: '04', chapterTitle: '', description: 'x', unit: 'יחידה', tags: [], source: 'manual', sourceRef: null, active: true }, uid('aEditor'));
      await expect(boq.createLibraryItem(orgA, { id, code: '4.10', chapter: '04', chapterTitle: '', description: 'x', unit: 'יחידה', tags: [], source: 'manual', sourceRef: null, active: true }, uid('aEditor'))).rejects.toBeInstanceOf(RepoConflictError);
      expect((await boq.patchLibraryItem(orgA, id, { active: false }, uid('aEditor')))?.active).toBe(false);
      expect((await boq.listLibraryItems(orgA, { active: false })).map((i) => i.id)).toContain(id);
      const importId = randomUUID();
      const now = new Date();
      await boq.createLibraryImport(orgA, {
        id: importId, orgId: orgA, projectId: null, sourceKind: 'xlsx', storagePath: storagePaths.libraryImport(orgA, importId, 'xlsx'), originalName: 'a.xlsx', sizeBytes: 10,
        status: 'awaiting_upload', jobId: null, createdBy: uid('aEditor'), createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString(), finalizedAt: null, stats: null, error: null,
      });
      const q = await boq.queueLibraryImport(orgA, importId, uid('aEditor'));
      expect(q).toMatchObject({ created: true, doc: { status: 'queued' } });
      expect((await boq.queueLibraryImport(orgA, importId, uid('aEditor')))?.created).toBe(false);
      expect((await db.doc(fsPaths.job(q?.jobId as string)).get()).data()).toMatchObject({ type: 'library.import', importId, orgId: orgA, projectId: null });
      const counts = { lines: 1, green: 0, yellow: 1, red: 0, draft: 1, reviewed: 0, approved: 0, overridden: 0 };
      await boq.createExport(orgA, pid, { id: 'e1', templateId: 'tpl_default', split: 'summed', markDraft: false, storagePath: storagePaths.boqExportFile(orgA, pid, 'e1'), buildId: null, counts, sha256: 'a'.repeat(64), sizeBytes: 10, createdBy: uid('aEditor'), createdAt: now.toISOString() });
      expect((await db.doc(fsPaths.boqExport(orgA, pid, 'e1')).get()).get('createdAt')).toBeInstanceOf(Timestamp);
    });
  });

  describe.skipIf(!hasStorage)('full finalize with the Storage emulator', () => {
    it('verifies, moves quarantine → uploads/{sheetSetId}/source.png and publishes', async () => {
      const storage: ObjectStorage = new FirebaseObjectStorage(app, BUCKET);
      const queue = new InMemoryIngestQueue();
      const uploads = new UploadsService(access, repo, queue, storage, new UploadTokenSigner(UPLOAD_SECRET));
      const p = await projects.create(user(uid('aEditor')), { orgId: orgA, name: 'upload' });
      const up = await uploads.createUpload(user(uid('aEditor')), p.id, { filename: 'a.png', sizeBytes: SAMPLE.png.length });
      await getStorage(app).bucket(BUCKET).file(up.storagePath).save(SAMPLE.png, { contentType: 'image/png' });
      const res = await uploads.finalize(user(uid('aEditor')), p.id, { uploadToken: up.uploadToken }, TRACE);
      expect(res.sheetSet.storagePath).toBe(storagePaths.projectUpload(orgA, p.id, res.sheetSet.sha256, 'png'));
      expect(await storage.exists(res.sheetSet.storagePath)).toBe(true);
      const [stillThere] = await getStorage(app).bucket(BUCKET).file(up.storagePath).exists();
      expect(stillThere).toBe(false);
      expect(queue.messages).toHaveLength(1);
      expect(queue.messages[0]?.data).toMatchObject({ schemaVersion: 3, storagePath: res.sheetSet.storagePath, sheetId: null });
    });
  });

  describe.skipIf(!hasPubSub)('Pub/Sub emulator', () => {
    it('publishes the contract payload with attributes to topic ingest', async () => {
      const client = new PubSub({ projectId: PROJECT });
      const topicName = `ingest-${run}`;
      const [topic] = await client.createTopic(topicName);
      const [sub] = await topic.createSubscription(`sub-${run}`);
      const q = new PubSubIngestQueue(PROJECT, topicName, client);
      const sha = 'f'.repeat(64);
      const payload = {
        schemaVersion: 3 as const,
        type: 'ingest.sheet_version' as const,
        jobId: 'job1',
        orgId: orgA,
        projectId: 'p1',
        sheetSetId: sha,
        sheetId: null,
        pageIndex: null,
        versionId: 'v1',
        storagePath: storagePaths.projectUpload(orgA, 'p1', sha, 'pdf'),
        sha256: sha,
        fileKind: 'pdf' as const,
        traceparent: null,
      };
      const received = new Promise<{ data: unknown; attributes: Record<string, string> }>((resolve) => {
        sub.on('message', (m) => {
          m.ack();
          resolve({ data: JSON.parse(m.data.toString()), attributes: m.attributes });
        });
      });
      await q.publish(payload);
      const msg = await received;
      expect(msg.data).toEqual(payload);
      expect(msg.attributes).toMatchObject({ type: 'ingest.sheet_version', jobId: 'job1', orgId: orgA });
      await sub.close();
      await q.close();
    });
  });
});
