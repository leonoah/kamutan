import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthContext, OrgAccess } from '../../src/auth/auth-context';
import { InMemoryRepository } from '../../src/db/in-memory.repository';
import { InMemoryIngestQueue, type IngestQueue } from '../../src/queue/ingest-queue';
import { LocalObjectStorage } from '../../src/uploads/storage/local.storage';
import { UploadTokenSigner } from '../../src/uploads/upload-token';
import { UploadsService } from '../../src/uploads/uploads.service';
import { SAMPLE, UPLOAD_SECRET } from '../support/helpers';

const TRACE = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('UploadsService', () => {
  let repo: InMemoryRepository;
  let queue: InMemoryIngestQueue;
  let storage: LocalObjectStorage;
  let service: UploadsService;
  let user: AuthContext;
  let access: OrgAccess;
  let projectId: string;

  const makeService = (q: IngestQueue = queue) =>
    new UploadsService(repo, q, storage, new UploadTokenSigner(UPLOAD_SECRET));

  /** create → put bytes → return token & path */
  async function upload(filename: string, body: Buffer) {
    const created = await service.createUpload(user, access, projectId, { filename, sizeBytes: body.length });
    await storage.write(created.storagePath, Readable.from([body]), created.maxBytes);
    return created;
  }

  beforeEach(async () => {
    repo = new InMemoryRepository();
    queue = new InMemoryIngestQueue();
    storage = new LocalObjectStorage(mkdtempSync(join(tmpdir(), 'kamutan-svc-')), 'http://api.test', UPLOAD_SECRET);
    service = makeService();
    const userId = randomUUID();
    user = { userId, aal: 'aal1', claims: { sub: userId, role: 'authenticated', exp: 9e9 } };
    const org = repo.seedOrg({ name: 'Org', slug: 'org' }, { [userId]: 'editor' });
    access = { orgId: org.id, role: 'editor' };
    projectId = (await repo.run(user, (tx) => tx.createProject({ orgId: org.id, name: 'P', address: null }))).id;
  });

  it('issues a path inside the org prefix without the user filename', async () => {
    const r = await service.createUpload(user, access, projectId, { filename: '../../evil.pdf', sizeBytes: 10 });
    expect(r.storagePath).toMatch(new RegExp(`^${access.orgId}/upload/[0-9a-f-]{36}$`));
    expect(r.storagePath).not.toContain('evil');
    expect(r.fileKind).toBe('pdf');
    expect(r.uploadUrl).toMatch(/^http:\/\/api\.test\/v1\/local-storage\//);
  });

  it('finalizes: hashes, creates rows, enqueues one ingest job with ids only', async () => {
    const up = await upload('קומה א.pdf', SAMPLE.pdf);
    const res = await service.finalize(user, access, projectId, { uploadToken: up.uploadToken }, TRACE);

    expect(res.deduplicated).toBe(false);
    expect(res.sheetSet).toMatchObject({ name: 'קומה א.pdf', fileKind: 'pdf', projectId, orgId: access.orgId });
    expect(res.sheetSet.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.sheetVersion).toMatchObject({ versionNo: 1, status: 'queued', storagePath: up.storagePath });
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]).toMatchObject({
      id: res.jobId,
      name: 'ingest.sheet_version',
      queue: 'ingest',
      payload: {
        schemaVersion: 1,
        sheetVersionId: res.sheetVersion.id,
        orgId: access.orgId,
        projectId,
        storagePath: up.storagePath,
        sha256: res.sheetSet.sourceSha256,
        fileKind: 'pdf',
        traceparent: TRACE,
      },
    });
    expect(repo.store.audit).toEqual([
      expect.objectContaining({ entity: 'sheet_sets', action: 'upload', entityId: res.sheetSet.id }),
    ]);
  });

  it('dedupes identical bytes within a project (no new rows/jobs, duplicate object removed)', async () => {
    const first = await upload('a.pdf', SAMPLE.pdf);
    const r1 = await service.finalize(user, access, projectId, { uploadToken: first.uploadToken }, TRACE);
    const second = await upload('copy of a.pdf', SAMPLE.pdf);
    const r2 = await service.finalize(user, access, projectId, { uploadToken: second.uploadToken }, TRACE);

    expect(r2.deduplicated).toBe(true);
    expect(r2.sheetSet.id).toBe(r1.sheetSet.id);
    expect(r2.sheetVersion.id).toBe(r1.sheetVersion.id);
    expect(r2.jobId).toBe(r1.jobId);
    expect(queue.jobs).toHaveLength(1);
    expect(repo.store.sheetSets.size).toBe(1);
    expect(await storage.openRead(second.storagePath)).toBeNull();
    expect(await storage.openRead(first.storagePath)).not.toBeNull();
  });

  it('does not dedupe across projects', async () => {
    const other = (await repo.run(user, (tx) => tx.createProject({ orgId: access.orgId, name: 'P2', address: null }))).id;
    const a = await upload('a.pdf', SAMPLE.pdf);
    await service.finalize(user, access, projectId, { uploadToken: a.uploadToken }, TRACE);
    const b = await service.createUpload(user, access, other, { filename: 'a.pdf', sizeBytes: SAMPLE.pdf.length });
    await storage.write(b.storagePath, Readable.from([SAMPLE.pdf]), b.maxBytes);
    const r = await service.finalize(user, access, other, { uploadToken: b.uploadToken }, TRACE);
    expect(r.deduplicated).toBe(false);
    expect(queue.jobs).toHaveLength(2);
  });

  it('rejects content that does not match the extension (415) and deletes it', async () => {
    const up = await upload('plan.pdf', SAMPLE.png);
    await expect(service.finalize(user, access, projectId, { uploadToken: up.uploadToken }, TRACE)).rejects.toMatchObject({
      status: 415,
      code: 'unsupported_file_type',
    });
    expect(await storage.openRead(up.storagePath)).toBeNull();
    expect(repo.store.sheetSets.size).toBe(0);
    expect(queue.jobs).toHaveLength(0);
  });

  it('rejects disallowed content even with an allowed extension', async () => {
    const up = await upload('x.dwg', Buffer.from('MZ\x90\x00 this is an exe', 'latin1'));
    await expect(service.finalize(user, access, projectId, { uploadToken: up.uploadToken }, TRACE)).rejects.toMatchObject({ status: 415 });
  });

  it('409 when nothing was uploaded; 400 for a token of another project/user', async () => {
    const up = await service.createUpload(user, access, projectId, { filename: 'a.pdf', sizeBytes: 5 });
    await expect(service.finalize(user, access, projectId, { uploadToken: up.uploadToken }, TRACE)).rejects.toMatchObject({
      status: 409,
      code: 'upload_missing',
    });
    await expect(service.finalize(user, access, randomUUID(), { uploadToken: up.uploadToken }, TRACE)).rejects.toMatchObject({ status: 400 });
    const otherUser = { ...user, userId: randomUUID() };
    await expect(service.finalize(otherUser, access, projectId, { uploadToken: up.uploadToken }, TRACE)).rejects.toMatchObject({ status: 400 });
    await expect(service.finalize(user, access, projectId, { uploadToken: 'garbage.token-garbage' }, TRACE)).rejects.toMatchObject({ status: 400 });
  });

  it('a failed enqueue leaves the version `uploaded`; retrying finalize re-enqueues idempotently', async () => {
    let fail = true;
    const flaky: IngestQueue = {
      enqueueIngest: async (p, o) => {
        if (fail) throw new Error('redis down');
        return queue.enqueueIngest(p, o);
      },
      ping: async () => undefined,
      close: async () => undefined,
    };
    const svc = makeService(flaky);
    const up = await upload('a.dxf', SAMPLE.dxf);
    await expect(svc.finalize(user, access, projectId, { uploadToken: up.uploadToken }, TRACE)).rejects.toMatchObject({ status: 503 });
    const [sv] = [...repo.store.sheetVersions.values()];
    expect(sv?.status).toBe('uploaded');

    fail = false;
    const r = await svc.finalize(user, access, projectId, { uploadToken: up.uploadToken }, TRACE);
    expect(r.deduplicated).toBe(true);
    expect(r.sheetVersion.status).toBe('queued');
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]?.payload.fileKind).toBe('dxf');
    // Retrying again does not enqueue twice.
    await svc.finalize(user, access, projectId, { uploadToken: up.uploadToken }, TRACE);
    expect(queue.jobs).toHaveLength(1);
  });
});
