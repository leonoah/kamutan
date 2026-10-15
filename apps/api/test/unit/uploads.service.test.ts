import { beforeEach, describe, expect, it } from 'vitest';
import { fsPaths, IngestSheetVersionJobSchema, storagePaths } from '@kamutan/contracts';
import { AccessService } from '../../src/access/access.service';
import type { AuthContext } from '../../src/auth/auth-context';
import { InMemoryRepository } from '../../src/db/in-memory.repository';
import { InMemoryIngestQueue, type IngestQueue } from '../../src/queue/ingest-queue';
import { InMemoryObjectStorage } from '../../src/uploads/storage/in-memory.storage';
import { UploadTokenSigner } from '../../src/uploads/upload-token';
import { UploadsService } from '../../src/uploads/uploads.service';
import { user } from '../support/fake-verifier';
import { SAMPLE, UPLOAD_SECRET } from '../support/helpers';

const TRACE = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('UploadsService (Firestore/Storage layout, in-memory fakes)', () => {
  let repo: InMemoryRepository;
  let queue: InMemoryIngestQueue;
  let storage: InMemoryObjectStorage;
  let service: UploadsService;
  let editor: AuthContext;
  let orgId: string;
  let projectId: string;

  const makeService = (q: IngestQueue = queue) =>
    new UploadsService(new AccessService(repo), repo, q, storage, new UploadTokenSigner(UPLOAD_SECRET));

  /** create → client uploads directly to Storage → token */
  async function upload(filename: string, body: Buffer, svc = service) {
    const created = await svc.createUpload(editor, projectId, { filename, sizeBytes: body.length });
    storage.put(created.storagePath, body, created.contentType);
    return created;
  }

  beforeEach(async () => {
    repo = new InMemoryRepository();
    queue = new InMemoryIngestQueue();
    storage = new InMemoryObjectStorage();
    service = makeService();
    editor = user('editorUid');
    orgId = repo.seedOrg('Org', { editorUid: 'editor' }).id;
    projectId = (await repo.createProject(orgId, { name: 'P' }, 'editorUid')).id;
  });

  it('issues orgs/{orgId}/quarantine/{uuid} without the user filename (SEC-13)', async () => {
    const r = await service.createUpload(editor, projectId, { filename: '../../evil.pdf', sizeBytes: 10 });
    expect(r.fileId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(r.storagePath).toBe(storagePaths.quarantine(orgId, r.fileId));
    expect(r.storagePath).not.toContain('evil');
    expect(r).toMatchObject({ fileKind: 'pdf', contentType: 'application/pdf', maxBytes: 100 * 1024 * 1024 });
    expect(Date.parse(r.expiresAt) - Date.now()).toBeLessThanOrEqual(600_000);
  });

  it('finalize: verifies, moves quarantine → uploads/{sheetSetId}/source.{ext}, writes set + job + audit, publishes v3', async () => {
    const up = await upload('קומה א.pdf', SAMPLE.pdf);
    const res = await service.finalize(editor, projectId, { uploadToken: up.uploadToken }, TRACE);
    const sha = res.sheetSet.sha256;
    const dest = storagePaths.projectUpload(orgId, projectId, sha, 'pdf');

    expect(res.deduplicated).toBe(false);
    expect(res.sheetSet).toMatchObject({ id: sha, name: 'קומה א.pdf', fileKind: 'pdf', storagePath: dest, status: 'queued', uploadedBy: 'editorUid' });
    expect(res.sheetSet).toMatchObject({ ingestJobId: res.jobId, versionId: res.versionId });

    // Storage: moved (attachment metadata), nothing left in quarantine.
    expect(storage.objects.get(dest)).toMatchObject({ contentType: 'application/pdf', metadata: { sha256: sha, uploadedBy: 'editorUid', originalName: 'קומה א.pdf' } });
    expect(storage.objects.has(up.storagePath)).toBe(false);
    expect([...storage.objects.keys()]).toEqual([dest]);

    // Firestore docs at ADR 0008 paths; sheets are created by the worker, not here.
    expect(repo.docs.get(fsPaths.sheetSet(orgId, projectId, sha))).toMatchObject({ status: 'queued', uploadFileId: up.fileId });
    expect([...repo.docs.keys()].some((k) => k.includes('/sheets/'))).toBe(false);
    expect(repo.docs.get(fsPaths.job(res.jobId))).toMatchObject({
      orgId,
      projectId,
      sheetSetId: sha,
      sheetId: null,
      versionId: res.versionId,
      type: 'ingest.sheet_version',
      status: 'queued',
      progress: { stage: 'ingest', pct: 0 },
      attempts: 0,
    });
    const audit = [...repo.docs.entries()].filter(([k]) => k.startsWith(`orgs/${orgId}/auditLog/`)).map(([, v]) => v);
    expect(audit.map((a) => a.action)).toEqual(['create', 'upload']); // project create, upload
    expect(audit[1]?.prevHash).toBe(audit[0]?.hash);

    // Pub/Sub message = contract payload (initial ingest: all pages).
    expect(queue.messages).toHaveLength(1);
    const msg = queue.messages[0];
    expect(IngestSheetVersionJobSchema.parse(msg?.data)).toEqual({
      schemaVersion: 3,
      type: 'ingest.sheet_version',
      jobId: res.jobId,
      orgId,
      projectId,
      sheetSetId: sha,
      sheetId: null,
      pageIndex: null,
      versionId: res.versionId,
      storagePath: dest,
      sha256: sha,
      fileKind: 'pdf',
      traceparent: TRACE,
    });
    expect(msg?.attributes).toEqual({ type: 'ingest.sheet_version', jobId: res.jobId, orgId, schemaVersion: '3' });
  });

  it('dedupes identical bytes within a project: same docs/job, no new message, duplicate upload deleted', async () => {
    const first = await upload('a.pdf', SAMPLE.pdf);
    const r1 = await service.finalize(editor, projectId, { uploadToken: first.uploadToken }, TRACE);
    const second = await upload('copy of a.pdf', SAMPLE.pdf);
    const r2 = await service.finalize(editor, projectId, { uploadToken: second.uploadToken }, TRACE);

    expect(r2).toMatchObject({ deduplicated: true, jobId: r1.jobId });
    expect(r2.sheetSet.id).toBe(r1.sheetSet.id);
    expect(r2.versionId).toBe(r1.versionId);
    expect(queue.messages).toHaveLength(1);
    expect(storage.objects.has(second.storagePath)).toBe(false);
    expect([...repo.docs.keys()].filter((k) => k.includes('/sheetSets/'))).toHaveLength(1);
  });

  it('does not dedupe across projects', async () => {
    const other = (await repo.createProject(orgId, { name: 'P2' }, 'editorUid')).id;
    const a = await upload('a.pdf', SAMPLE.pdf);
    await service.finalize(editor, projectId, { uploadToken: a.uploadToken }, TRACE);
    const b = await service.createUpload(editor, other, { filename: 'a.pdf', sizeBytes: SAMPLE.pdf.length });
    storage.put(b.storagePath, SAMPLE.pdf);
    const r = await service.finalize(editor, other, { uploadToken: b.uploadToken }, TRACE);
    expect(r.deduplicated).toBe(false);
    expect(queue.messages).toHaveLength(2);
  });

  it.each([
    ['png', 'a.png', SAMPLE.png, 'image/png'],
    ['dxf', 'b.dxf', SAMPLE.dxf, 'application/dxf'],
    ['dwg', 'c.dwg', SAMPLE.dwg, 'application/acad'],
  ] as const)('accepts %s by magic bytes', async (kind, name, body, ct) => {
    const up = await upload(name, body);
    const r = await service.finalize(editor, projectId, { uploadToken: up.uploadToken }, TRACE);
    expect(r.sheetSet.fileKind).toBe(kind);
    expect(r.sheetSet.storagePath.endsWith(`.${kind}`)).toBe(true);
    expect(storage.objects.get(r.sheetSet.storagePath)?.contentType).toBe(ct);
  });

  it('rejects content that does not match the extension (415) and deletes the upload', async () => {
    const up = await upload('plan.pdf', SAMPLE.png);
    await expect(service.finalize(editor, projectId, { uploadToken: up.uploadToken }, TRACE)).rejects.toMatchObject({
      status: 415,
      code: 'unsupported_file_type',
    });
    expect(storage.objects.size).toBe(0);
    expect([...repo.docs.keys()].some((k) => k.includes('/sheetSets/'))).toBe(false);
    expect(queue.messages).toHaveLength(0);
  });

  it('rejects disallowed content with an allowed extension', async () => {
    const up = await upload('x.dwg', Buffer.from('MZ\x90\x00 this is an exe', 'latin1'));
    await expect(service.finalize(editor, projectId, { uploadToken: up.uploadToken }, TRACE)).rejects.toMatchObject({ status: 415 });
  });

  it('409 when nothing was uploaded; 400 for a token of another project/user; 400 for garbage', async () => {
    const up = await service.createUpload(editor, projectId, { filename: 'a.pdf', sizeBytes: 5 });
    await expect(service.finalize(editor, projectId, { uploadToken: up.uploadToken }, TRACE)).rejects.toMatchObject({ status: 409, code: 'upload_missing' });
    const other = (await repo.createProject(orgId, { name: 'P2' }, 'editorUid')).id;
    await expect(service.finalize(editor, other, { uploadToken: up.uploadToken }, TRACE)).rejects.toMatchObject({ status: 400 });
    repo.setMember(orgId, 'editor2', 'editor');
    await expect(service.finalize(user('editor2'), projectId, { uploadToken: up.uploadToken }, TRACE)).rejects.toMatchObject({ status: 400 });
    await expect(service.finalize(editor, projectId, { uploadToken: 'garbage.token-garbage' }, TRACE)).rejects.toMatchObject({ status: 400 });
  });

  it('rejects oversize objects with 413 and deletes them from quarantine', async () => {
    const big = Buffer.concat([SAMPLE.pdf, Buffer.alloc(100 * 1024 * 1024)]);
    const up = await upload('big.pdf', big);
    await expect(service.finalize(editor, projectId, { uploadToken: up.uploadToken }, TRACE)).rejects.toMatchObject({ status: 413 });
    expect(storage.objects.size).toBe(0);
    expect(queue.messages).toHaveLength(0);
  });

  it('a failed publish leaves the set `uploaded`; retrying finalize with the same token publishes once', async () => {
    let fail = true;
    const flaky: IngestQueue = {
      publish: async (p) => {
        if (fail) throw new Error('pubsub unavailable');
        return queue.publish(p);
      },
      ping: async () => undefined,
      close: async () => undefined,
    };
    const svc = makeService(flaky);
    const up = await upload('a.dxf', SAMPLE.dxf, svc);
    await expect(svc.finalize(editor, projectId, { uploadToken: up.uploadToken }, TRACE)).rejects.toMatchObject({ status: 503 });
    expect(storage.objects.has(up.storagePath)).toBe(false); // checks passed → already moved
    const set = [...repo.docs.entries()].find(([k]) => k.includes('/sheetSets/'));
    expect(set?.[1].status).toBe('uploaded');

    fail = false;
    const r = await svc.finalize(editor, projectId, { uploadToken: up.uploadToken }, TRACE);
    expect(r).toMatchObject({ deduplicated: true, sheetSet: { status: 'queued' } });
    expect(queue.messages).toHaveLength(1);
    // Same token again: idempotent, nothing re-published.
    const again = await svc.finalize(editor, projectId, { uploadToken: up.uploadToken }, TRACE);
    expect(again).toMatchObject({ jobId: r.jobId, sheetSet: { status: 'queued' } });
    expect(queue.messages).toHaveLength(1);
  });
});
