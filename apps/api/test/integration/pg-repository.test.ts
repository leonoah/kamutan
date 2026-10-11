import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthContext } from '../../src/auth/auth-context';
import { PgRepository } from '../../src/db/pg.repository';
import { createMigratedPglite, migrationsAvailable, PgliteDatabase } from '../support/pglite';

/**
 * Runs the production repository SQL against the real Supabase migrations
 * (PGlite + PostGIS) as role `authenticated`, so RLS policies are exercised.
 */
describe.skipIf(!migrationsAvailable())('PgRepository on migrated Postgres (PGlite, RLS enforced)', () => {
  let db: PGlite;
  let repo: PgRepository;
  const users = { admin: randomUUID(), editor: randomUUID(), viewer: randomUUID(), outsider: randomUUID() };
  const as = (userId: string): AuthContext => ({
    userId,
    aal: 'aal1',
    claims: { sub: userId, role: 'authenticated', aud: 'authenticated', exp: 9e9 },
  });
  let orgId: string;
  let projectId: string;
  const sha = 'c'.repeat(64);

  beforeAll(async () => {
    db = await createMigratedPglite();
    for (const id of Object.values(users)) await db.query('insert into auth.users (id) values ($1)', [id]);
    repo = new PgRepository(new PgliteDatabase(db));
    const org = await repo.run(as(users.admin), (tx) => tx.createOrg('משרד בדיקה', 'test-office'));
    orgId = org.id;
    // Seed memberships as superuser (admin invite flow is not part of Sprint 0 API).
    await db.query(`insert into public.memberships (org_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'viewer')`, [
      orgId,
      users.editor,
      users.viewer,
    ]);
    await repo.run(as(users.outsider), (tx) => tx.createOrg('Other', 'other-office'));
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('createOrg makes the caller admin; slug conflicts map to 409', async () => {
    expect(await repo.run(as(users.admin), (tx) => tx.getMyRole(orgId))).toBe('admin');
    await expect(repo.run(as(users.editor), (tx) => tx.createOrg('Dup', 'test-office'))).rejects.toMatchObject({ status: 409 });
  });

  it('listMyOrgs / getOrg are tenant-scoped', async () => {
    const mine = await repo.run(as(users.viewer), (tx) => tx.listMyOrgs());
    expect(mine.map((o) => [o.id, o.role])).toEqual([[orgId, 'viewer']]);
    expect(await repo.run(as(users.outsider), (tx) => tx.getOrg(orgId))).toBeNull();
    expect(await repo.run(as(users.outsider), (tx) => tx.getMyRole(orgId))).toBeNull();
  });

  it('projects: editor creates, viewer reads, RLS blocks viewer writes and outsiders', async () => {
    const p = await repo.run(as(users.editor), (tx) => tx.createProject({ orgId, name: 'בית נח', address: null }));
    projectId = p.id;
    expect(p).toMatchObject({ orgId, status: 'active', createdBy: users.editor });
    expect(await repo.run(as(users.viewer), (tx) => tx.getProject(p.id))).toMatchObject({ id: p.id });
    expect(await repo.run(as(users.outsider), (tx) => tx.getProject(p.id))).toBeNull();
    await expect(repo.run(as(users.viewer), (tx) => tx.createProject({ orgId, name: 'x', address: null }))).rejects.toThrow(
      /row-level security/,
    );
    // Outsider update silently affects no rows.
    expect(await repo.run(as(users.outsider), (tx) => tx.updateProject(p.id, { name: 'hacked' }))).toBeNull();
    expect(await repo.run(as(users.editor), (tx) => tx.updateProject(p.id, { address: 'כתובת' }))).toMatchObject({ address: 'כתובת' });
  });

  it('cursor pagination', async () => {
    for (let i = 0; i < 4; i++) await repo.run(as(users.editor), (tx) => tx.createProject({ orgId, name: `P${i}`, address: null }));
    const p1 = await repo.run(as(users.viewer), (tx) => tx.listProjects({ orgId, limit: 3 }));
    expect(p1.items).toHaveLength(3);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await repo.run(as(users.viewer), (tx) => tx.listProjects({ orgId, limit: 3, cursor: p1.nextCursor ?? undefined }));
    expect(p2.items).toHaveLength(2);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((p) => p.id)).size).toBe(5);
    expect((await repo.run(as(users.outsider), (tx) => tx.listProjects({ limit: 50 }))).items).toHaveLength(0);
  });

  it('sheet set + version + job + audit, then dedupe lookup', async () => {
    const storagePath = `${orgId}/upload/${randomUUID()}`;
    const created = await repo.run(as(users.editor), async (tx) => {
      await tx.lockProjectFile(projectId, sha);
      expect(await tx.findSheetSetBySha(projectId, sha)).toBeNull();
      const c = await tx.createSheetSetWithVersion({ orgId, projectId, name: 'a.png', storagePath, sha256: sha, fileKind: 'png' });
      const jobId = await tx.createJob({ orgId, projectId, sheetVersionId: c.sheetVersion.id, type: 'ingest.sheet_version', inputHash: sha });
      await tx.writeAudit({ orgId, entity: 'sheet_sets', entityId: c.sheetSet.id, action: 'upload', after: { sha256: sha } });
      return { ...c, jobId };
    });
    expect(created.sheetSet).toMatchObject({ fileKind: 'png', sourceSha256: sha, uploadedBy: users.editor });
    expect(created.sheetVersion).toMatchObject({ versionNo: 1, status: 'uploaded', storagePath, pageIndex: 0, isRaster: false });
    expect((await db.query(`select file_kind from public.sheet_sets where id = $1`, [created.sheetSet.id])).rows).toEqual([
      { file_kind: 'image' },
    ]);

    await repo.run(as(users.editor), (tx) => tx.setSheetVersionStatus(created.sheetVersion.id, 'queued'));
    const found = await repo.run(as(users.viewer), (tx) => tx.findSheetSetBySha(projectId, sha));
    expect(found?.sheetVersion).toMatchObject({ id: created.sheetVersion.id, status: 'queued' });
    expect(await repo.run(as(users.viewer), (tx) => tx.findJobId(created.sheetVersion.id, 'ingest.sheet_version'))).toBe(created.jobId);
    expect(await repo.run(as(users.outsider), (tx) => tx.findSheetSetBySha(projectId, sha))).toBeNull();

    const audit = await db.query<{ action: string; actor_id: string }>(
      `select action, actor_id from public.audit_log where entity = 'sheet_sets' and entity_id = $1`,
      [created.sheetSet.id],
    );
    expect(audit.rows).toEqual([{ action: 'upload', actor_id: users.editor }]);
  });

  it('viewer cannot create sheet sets (RLS)', async () => {
    await expect(
      repo.run(as(users.viewer), (tx) =>
        tx.createSheetSetWithVersion({ orgId, projectId, name: 'x', storagePath: `${orgId}/upload/${randomUUID()}`, sha256: 'd'.repeat(64), fileKind: 'pdf' }),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
