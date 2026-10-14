import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { afterAll, describe, expect, it } from 'vitest';
import type { AuthContext } from '../../src/auth/auth-context';
import { AccessDenied, FirestoreRepository } from '../../src/db/firestore.repository';

// Runs only against the Firestore emulator: `firebase emulators:exec --only firestore "pnpm test"`.
const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const user = (userId: string): AuthContext => ({
  userId,
  aal: 'aal1',
  claims: { sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 },
});

describe.skipIf(!emulator)('FirestoreRepository (emulator)', () => {
  const app = getApps()[0] ?? initializeApp({ projectId: 'demo-kamutan' });
  const repo = new FirestoreRepository(getFirestore(app));
  afterAll(() => repo.close());

  const alice = user(`alice-${randomUUID()}`);
  const bob = user(`bob-${randomUUID()}`);
  const slug = `org-${randomUUID().slice(0, 8)}`;

  it('creates an org with the caller as admin and enforces unique slugs', async () => {
    const org = await repo.run(alice, (tx) => tx.createOrg('Studio', slug));
    expect(await repo.run(alice, (tx) => tx.getMyRole(org.id))).toBe('admin');
    expect((await repo.run(alice, (tx) => tx.listMyOrgs())).map((o) => o.id)).toContain(org.id);
    await expect(repo.run(bob, (tx) => tx.createOrg('Other', slug))).rejects.toMatchObject({ status: 409 });
  });

  it('hides orgs and projects from non-members and denies their writes', async () => {
    const org = await repo.run(alice, (tx) => tx.createOrg('Private', `org-${randomUUID().slice(0, 8)}`));
    const project = await repo.run(alice, (tx) => tx.createProject({ orgId: org.id, name: 'P1', address: null }));
    expect(await repo.run(bob, (tx) => tx.getOrg(org.id))).toBeNull();
    expect(await repo.run(bob, (tx) => tx.getProject(project.id))).toBeNull();
    expect((await repo.run(bob, (tx) => tx.listProjects({ limit: 10 }))).items).toEqual([]);
    await expect(
      repo.run(bob, (tx) => tx.createProject({ orgId: org.id, name: 'x', address: null })),
    ).rejects.toBeInstanceOf(AccessDenied);
  });

  it('lists projects newest first with cursor pagination', async () => {
    const org = await repo.run(alice, (tx) => tx.createOrg('Paged', `org-${randomUUID().slice(0, 8)}`));
    for (const name of ['a', 'b', 'c']) {
      await repo.run(alice, (tx) => tx.createProject({ orgId: org.id, name, address: null }));
    }
    const p1 = await repo.run(alice, (tx) => tx.listProjects({ orgId: org.id, limit: 2 }));
    expect(p1.items.map((p) => p.name)).toEqual(['c', 'b']);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await repo.run(alice, (tx) => tx.listProjects({ orgId: org.id, limit: 2, cursor: p1.nextCursor as string }));
    expect(p2.items.map((p) => p.name)).toEqual(['a']);
    expect(p2.nextCursor).toBeNull();
  });

  it('dedupes an upload of the same bytes and finds its job', async () => {
    const org = await repo.run(alice, (tx) => tx.createOrg('Uploads', `org-${randomUUID().slice(0, 8)}`));
    const project = await repo.run(alice, (tx) => tx.createProject({ orgId: org.id, name: 'U', address: null }));
    const sha = 'a'.repeat(64);
    const created = await repo.run(alice, async (tx) => {
      const c = await tx.createSheetSetWithVersion({
        orgId: org.id,
        projectId: project.id,
        name: 'plan.pdf',
        storagePath: `${org.id}/upload/${randomUUID()}`,
        sha256: sha,
        fileKind: 'pdf',
      });
      const jobId = await tx.createJob({ orgId: org.id, projectId: project.id, sheetVersionId: c.sheetVersion.id, type: 'ingest', inputHash: sha });
      return { ...c, jobId };
    });
    const found = await repo.run(alice, (tx) => tx.findSheetSetBySha(project.id, sha));
    expect(found?.sheetSet.id).toBe(created.sheetSet.id);
    expect(await repo.run(alice, (tx) => tx.findJobId(created.sheetVersion.id, 'ingest'))).toBe(created.jobId);
    expect(await repo.run(bob, (tx) => tx.findSheetSetBySha(project.id, sha))).toBeNull();
    await repo.run(alice, (tx) => tx.setSheetVersionStatus(created.sheetVersion.id, 'queued'));
  });
});
