import { describe, expect, it } from 'vitest';
import { fsPaths, storagePaths } from '@kamutan/contracts';
import { AccessService } from '../../src/access/access.service';
import { InMemoryBoqStorage } from '../../src/boq/boq-storage';
import { BoqService } from '../../src/boq/boq.service';
import { InMemoryBoqRepository } from '../../src/db/boq-memory.repository';
import { InMemoryRepository } from '../../src/db/in-memory.repository';
import { LibraryService } from '../../src/library/library.service';
import { InMemoryIngestQueue } from '../../src/queue/ingest-queue';
import { user } from '../support/fake-verifier';
import { xlsxBytes } from '../support/spreadsheets';
import { noahLines } from '../fixtures/noah-boq';

/** Sprint 3 services called directly (no RolesGuard): org B can never reach org A's BOQ / library (SEC-09). */
describe('BOQ + library service-level tenant isolation (no guards)', () => {
  const repo = new InMemoryRepository();
  const boqRepo = new InMemoryBoqRepository(repo);
  const access = new AccessService(repo);
  const storage = new InMemoryBoqStorage();
  const queue = new InMemoryIngestQueue();
  const boq = new BoqService(access, repo, boqRepo, storage, queue);
  const lib = new LibraryService(access, repo, boqRepo, storage, queue);
  const TRACE = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

  const A = repo.seedOrg('A', { aAdmin: 'admin', aEditor: 'editor', aReviewer: 'reviewer', aViewer: 'viewer' });
  const B = repo.seedOrg('B', { bAdmin: 'admin' });
  let pa = '';
  let pb = '';

  it('setup', async () => {
    pa = (await repo.createProject(A.id, { name: 'A' }, 'aEditor')).id;
    pb = (await repo.createProject(B.id, { name: 'B' }, 'bAdmin')).id;
    for (const l of noahLines()) boqRepo.seedLine(A.id, pa, l);
    await lib.createItem(user('aEditor'), { orgId: A.id, code: '4.10', chapter: '04', description: 'x', unit: 'יחידה' });
  });

  it('org B admin gets 404 on every project-scoped BOQ method of org A', async () => {
    const b = user('bAdmin');
    await expect(boq.requestBuild(b, pa, TRACE)).rejects.toMatchObject({ status: 404 });
    await expect(boq.view(b, pa, { limit: 10 })).rejects.toMatchObject({ status: 404 });
    await expect(boq.patchLine(b, pa, 'bl_4_00', { status: 'reviewed' })).rejects.toMatchObject({ status: 404 });
    await expect(boq.evidence(b, pa, 'bl_4_00')).rejects.toMatchObject({ status: 404 });
    await expect(boq.export(b, pa, { split: 'summed', markDraft: false })).rejects.toMatchObject({ status: 404 });
    // and its own project never shows A's lines
    expect((await boq.view(b, pb, { limit: 100 })).items).toEqual([]);
    expect(queue.messages).toHaveLength(0);
    expect(repo.docs.get(fsPaths.boqLine(A.id, pa, 'bl_4_00'))?.status).toBe('draft');
  });

  it('org B admin gets 404 on org A library / templates / rules / imports', async () => {
    const b = user('bAdmin');
    await expect(lib.listItems(b, { orgId: A.id, limit: 10 })).rejects.toMatchObject({ status: 404 });
    await expect(lib.createItem(b, { orgId: A.id, code: '1.01', chapter: '01', description: 'y', unit: 'קומפלט' })).rejects.toMatchObject({ status: 404 });
    await expect(lib.patchItem(b, A.id, 'whatever', { active: false })).rejects.toMatchObject({ status: 404 });
    await expect(lib.listTemplates(b, A.id)).rejects.toMatchObject({ status: 404 });
    await expect(lib.patchTemplate(b, A.id, 'tpl_default', { name: 'x' })).rejects.toMatchObject({ status: 404 });
    await expect(lib.listRules(b, A.id)).rejects.toMatchObject({ status: 404 });
    await expect(lib.patchRule(b, A.id, 'r_socket_single', { enabled: false })).rejects.toMatchObject({ status: 404 });
    await expect(lib.createImport(b, { orgId: A.id, filename: 'a.xlsx', sizeBytes: 10 })).rejects.toMatchObject({ status: 404 });
    // an import created in A cannot be finalized / read from B, even with A's import id
    const imp = await lib.createImport(user('aEditor'), { orgId: A.id, filename: 'a.xlsx', sizeBytes: 10 });
    storage.putImport(imp.storagePath, await xlsxBytes());
    await expect(lib.finalizeImport(b, A.id, imp.import.id, TRACE)).rejects.toMatchObject({ status: 404 });
    await expect(lib.finalizeImport(b, B.id, imp.import.id, TRACE)).rejects.toMatchObject({ status: 404 });
    await expect(lib.getImport(b, B.id, imp.import.id)).rejects.toMatchObject({ status: 404 });
    // B's own library lists nothing of A
    expect((await lib.listItems(b, { orgId: B.id, limit: 10 })).items).toEqual([]);
    // A's object untouched
    expect(storage.objects.has(storagePaths.libraryImport(A.id, imp.import.id, 'xlsx'))).toBe(true);
  });

  it('roles inside the org: viewer read-only, reviewer reviews, editor overrides/exports, admin rules/templates', async () => {
    await expect(boq.view(user('aViewer'), pa, { limit: 5 })).resolves.toBeDefined();
    await expect(boq.patchLine(user('aViewer'), pa, 'bl_4_00', { status: 'reviewed' })).rejects.toMatchObject({ status: 403 });
    await expect(boq.patchLine(user('aReviewer'), pa, 'bl_4_00', { qtyOverride: 1, reason: 'r' })).rejects.toMatchObject({ status: 403 });
    await expect(boq.patchLine(user('aReviewer'), pa, 'bl_4_00', { status: 'reviewed' })).resolves.toBeDefined();
    await expect(boq.requestBuild(user('aReviewer'), pa, TRACE)).rejects.toMatchObject({ status: 403 });
    await expect(boq.export(user('aReviewer'), pa, { split: 'summed', markDraft: false })).rejects.toMatchObject({ status: 403 });
    await expect(lib.patchRule(user('aEditor'), A.id, 'r_socket_single', { enabled: false })).rejects.toMatchObject({ status: 403 });
    await expect(lib.patchTemplate(user('aEditor'), A.id, 'tpl_default', { name: 'x' })).rejects.toMatchObject({ status: 403 });
    await expect(lib.createItem(user('aReviewer'), { orgId: A.id, code: '1.01', chapter: '01', description: 'y', unit: 'קומפלט' })).rejects.toMatchObject({ status: 403 });
  });
});
