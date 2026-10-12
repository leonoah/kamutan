/**
 * Integration tests against the Firebase emulators (run in CI):
 *   pnpm --filter @kamutan/api test:emulator
 *   (= firebase emulators:exec --only firestore,storage,pubsub --project demo-kamutan "vitest run test/integration")
 * Skipped when FIRESTORE_EMULATOR_HOST is unset (emulator downloads are blocked in the dev sandbox).
 * Storage / Pub/Sub parts additionally need FIREBASE_STORAGE_EMULATOR_HOST / PUBSUB_EMULATOR_HOST.
 */
import { randomUUID } from 'node:crypto';
import { PubSub } from '@google-cloud/pubsub';
import { fsPaths, storagePaths } from '@kamutan/contracts';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessService } from '../../src/access/access.service';
import { auditHash } from '../../src/db/audit-chain';
import { FirestoreRepository } from '../../src/db/firestore.repository';
import { InMemoryIngestQueue, PubSubIngestQueue } from '../../src/queue/ingest-queue';
import { ProjectsService } from '../../src/projects/projects.service';
import { FirebaseObjectStorage } from '../../src/uploads/storage/firebase.storage';
import type { ObjectStorage } from '../../src/uploads/storage/object-storage';
import { UploadTokenSigner } from '../../src/uploads/upload-token';
import { UploadsService } from '../../src/uploads/uploads.service';
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

  it('createSheetSetBundle is atomic and dedupes concurrent finalizations of the same sha256', async () => {
    const p = await repo.createProject(orgA, { name: 'race' }, uid('aEditor'));
    const sha = 'e'.repeat(64);
    const input = {
      name: 'a.pdf',
      sha256: sha,
      fileKind: 'pdf' as const,
      storagePath: storagePaths.source(orgA, p.id, sha, 'pdf'),
      uploadedBy: uid('aEditor'),
      sizeBytes: 10,
      jobType: 'ingest.sheet_version',
    };
    const results = await Promise.all([1, 2, 3].map(() => repo.createSheetSetBundle(orgA, p.id, input)));
    expect(results.filter((r) => !r.deduplicated)).toHaveLength(1);
    expect(new Set(results.map((r) => r.bundle.jobId)).size).toBe(1);
    expect((await db.collection(`orgs/${orgA}/projects/${p.id}/sheets`).get()).size).toBe(1);
    const jobId = results[0]?.bundle.jobId as string;
    expect((await db.doc(fsPaths.job(jobId)).get()).data()).toMatchObject({ orgId: orgA, projectId: p.id, status: 'queued', progress: 0 });
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

  describe.skipIf(!hasStorage)('full finalize with the Storage emulator', () => {
    it('verifies, copies to sources/, deletes the upload and publishes', async () => {
      const storage: ObjectStorage = new FirebaseObjectStorage(app, BUCKET);
      const queue = new InMemoryIngestQueue();
      const uploads = new UploadsService(access, repo, queue, storage, new UploadTokenSigner(UPLOAD_SECRET));
      const p = await projects.create(user(uid('aEditor')), { orgId: orgA, name: 'upload' });
      const up = await uploads.createUpload(user(uid('aEditor')), p.id, { filename: 'a.png', sizeBytes: SAMPLE.png.length });
      await getStorage(app).bucket(BUCKET).file(up.storagePath).save(SAMPLE.png, { contentType: 'image/png' });
      const res = await uploads.finalize(user(uid('aEditor')), p.id, { uploadToken: up.uploadToken }, TRACE);
      expect(res.sheetSet.storagePath).toBe(storagePaths.source(orgA, p.id, res.sheetSet.sha256, 'png'));
      expect(await storage.exists(res.sheetSet.storagePath)).toBe(true);
      const [stillThere] = await getStorage(app).bucket(BUCKET).file(up.storagePath).exists();
      expect(stillThere).toBe(false);
      expect(queue.messages).toHaveLength(1);
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
        schemaVersion: 2 as const,
        type: 'ingest.sheet_version' as const,
        jobId: 'job1',
        orgId: orgA,
        projectId: 'p1',
        sheetSetId: sha,
        sheetId: 's1',
        versionId: 'v1',
        storagePath: storagePaths.source(orgA, 'p1', sha, 'pdf'),
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
