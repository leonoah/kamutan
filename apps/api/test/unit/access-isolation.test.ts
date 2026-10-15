import { describe, expect, it } from 'vitest';
import { AccessService } from '../../src/access/access.service';
import { InMemoryRepository } from '../../src/db/in-memory.repository';
import { InMemoryIngestQueue } from '../../src/queue/ingest-queue';
import { OrgsService } from '../../src/orgs/orgs.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { InMemoryObjectStorage } from '../../src/uploads/storage/in-memory.storage';
import { UploadTokenSigner } from '../../src/uploads/upload-token';
import { UploadsService } from '../../src/uploads/uploads.service';
import { user } from '../support/fake-verifier';
import { SAMPLE, UPLOAD_SECRET } from '../support/helpers';

/**
 * firebase-admin bypasses Security Rules, so cross-org isolation must hold at
 * the SERVICE layer even when no route guard ran (SEC-09). These tests call the
 * services directly, without RolesGuard.
 */
describe('service-level tenant isolation (no guards)', () => {
  const repo = new InMemoryRepository();
  const access = new AccessService(repo);
  const storage = new InMemoryObjectStorage();
  const queue = new InMemoryIngestQueue();
  const orgs = new OrgsService(access, repo);
  const projects = new ProjectsService(access, repo);
  const uploads = new UploadsService(access, repo, queue, storage, new UploadTokenSigner(UPLOAD_SECRET));
  const TRACE = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

  const A = repo.seedOrg('A', { aAdmin: 'admin', aEditor: 'editor', aViewer: 'viewer' });
  const B = repo.seedOrg('B', { bAdmin: 'admin', bEditor: 'editor' });

  it('org B members cannot read org A or its projects', async () => {
    const pa = await projects.create(user('aEditor'), { orgId: A.id, name: 'A project' });
    await expect(orgs.get(user('bAdmin'), A.id)).rejects.toMatchObject({ status: 404 });
    await expect(projects.get(user('bAdmin'), pa.id)).rejects.toMatchObject({ status: 404 });
    await expect(projects.list(user('bAdmin'), { orgId: A.id, limit: 10 })).rejects.toMatchObject({ status: 404 });
  });

  it('org B members cannot create in or modify org A', async () => {
    const pa = await projects.create(user('aEditor'), { orgId: A.id, name: 'A2' });
    await expect(projects.create(user('bAdmin'), { orgId: A.id, name: 'x' })).rejects.toMatchObject({ status: 404 });
    await expect(projects.update(user('bEditor'), pa.id, { name: 'hacked' })).rejects.toMatchObject({ status: 404 });
    expect((await repo.getProject(A.id, pa.id))?.name).toBe('A2');
  });

  it('org B members cannot upload into or finalize in org A projects', async () => {
    const pa = await projects.create(user('aEditor'), { orgId: A.id, name: 'A3' });
    await expect(uploads.createUpload(user('bEditor'), pa.id, { filename: 'a.pdf', sizeBytes: 10 })).rejects.toMatchObject({ status: 404 });

    // A token legitimately issued in org A is useless to an org B user.
    const up = await uploads.createUpload(user('aEditor'), pa.id, { filename: 'a.pdf', sizeBytes: SAMPLE.pdf.length });
    storage.put(up.storagePath, SAMPLE.pdf);
    await expect(uploads.finalize(user('bAdmin'), pa.id, { uploadToken: up.uploadToken }, TRACE)).rejects.toMatchObject({ status: 404 });

    // An org B editor finalizing in their own project with org A's token → token mismatch.
    const pb = await projects.create(user('bEditor'), { orgId: B.id, name: 'B1' });
    await expect(uploads.finalize(user('bEditor'), pb.id, { uploadToken: up.uploadToken }, TRACE)).rejects.toMatchObject({ status: 400 });
    expect(queue.messages).toHaveLength(0);
  });

  it('within an org, roles are enforced at service level too', async () => {
    const pa = await projects.create(user('aEditor'), { orgId: A.id, name: 'A4' });
    await expect(projects.create(user('aViewer'), { orgId: A.id, name: 'x' })).rejects.toMatchObject({ status: 403 });
    await expect(projects.update(user('aViewer'), pa.id, { name: 'x' })).rejects.toMatchObject({ status: 403 });
    await expect(uploads.createUpload(user('aViewer'), pa.id, { filename: 'a.pdf', sizeBytes: 1 })).rejects.toMatchObject({ status: 403 });
    await expect(projects.get(user('aViewer'), pa.id)).resolves.toMatchObject({ id: pa.id });
  });

  it('unknown / malformed ids are 404, never a lookup in another tenant', async () => {
    await expect(projects.get(user('aAdmin'), 'does-not-exist')).rejects.toMatchObject({ status: 404 });
    await expect(projects.get(user('aAdmin'), '../../orgs/x')).rejects.toMatchObject({ status: 404 });
    await expect(orgs.get(user('aAdmin'), 'orgs/x/members')).rejects.toMatchObject({ status: 404 });
  });

  it('my orgs lists only memberships of the caller', async () => {
    expect((await orgs.myOrgs(user('aViewer'))).map((o) => [o.id, o.role])).toEqual([[A.id, 'viewer']]);
    expect(await orgs.myOrgs(user('nobody'))).toEqual([]);
  });
});
