import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  BoqRuleListSchema,
  BoqRuleSchema,
  BoqTemplateListSchema,
  BoqTemplateSchema,
  CreateLibraryImportResponseSchema,
  DEFAULT_BOQ_RULES_VERSION,
  fsPaths,
  ItemLibraryItemSchema,
  itemIdFor,
  LibraryImportJobSchema,
  LibraryImportViewSchema,
  LibraryItemPageSchema,
  storagePaths,
} from '@kamutan/contracts';
import type { Doc } from '../../src/db/mappers';
import { createTestApp, type TestApp } from '../support/app';
import { SAMPLE, testConfig } from '../support/helpers';
import { XLS_BYTES, xlsxBytes } from '../support/spreadsheets';

describe('Library e2e — items, imports, templates, rules (fake auth, in-memory everything)', () => {
  let t: TestApp;
  let http: ReturnType<typeof request>;
  const tok: Record<string, string> = {};
  let orgId: string;
  let otherOrg: string;
  let projectId: string;
  const auth = (who: string) => ({ authorization: `Bearer ${tok[who]}` });
  const audits = (o: string) =>
    [...t.repo.docs.entries()]
      .filter(([k]) => k.startsWith(`orgs/${o}/auditLog/`))
      .map(([, v]) => v)
      .sort((a, b) => (a.at as Date).getTime() - (b.at as Date).getTime());

  beforeAll(async () => {
    t = await createTestApp(testConfig({ THROTTLE_LIMIT: '1000', UPLOAD_THROTTLE_LIMIT: '100' }));
    http = request(t.app.getHttpServer());
    for (const who of ['admin', 'editor', 'editor2', 'reviewer', 'viewer', 'outsider']) tok[who] = t.auth.issue(who);
    orgId = t.repo.seedOrg('Org', { admin: 'admin', editor: 'editor', editor2: 'editor', reviewer: 'reviewer', viewer: 'viewer' }).id;
    otherOrg = t.repo.seedOrg('Other', { outsider: 'admin' }).id;
    projectId = (await t.repo.createProject(orgId, { name: 'P' }, 'editor')).id;
  });
  afterAll(async () => {
    await t.app.close();
  });

  describe('items', () => {
    const item = { code: '4.10', chapter: '04', chapterTitle: 'עבודות חשמל', description: "נק' מאור בעלת שני מפסקים מחליפים", unit: 'יחידה', tags: ['תאורה'] };

    it('editor creates (deterministic id, audited); duplicate 409; viewer/reviewer 403; outsider 404; org id required', async () => {
      for (const who of ['viewer', 'reviewer']) expect((await http.post('/api/v1/library/items').set(auth(who)).send({ orgId, ...item })).status).toBe(403);
      expect((await http.post('/api/v1/library/items').set(auth('outsider')).send({ orgId, ...item })).status).toBe(404);
      expect((await http.post('/api/v1/library/items').set(auth('editor')).send(item)).status).toBe(400);
      const r = await http.post('/api/v1/library/items').set(auth('editor')).send({ orgId, ...item });
      expect(r.status).toBe(201);
      const created = ItemLibraryItemSchema.parse(r.body);
      expect(created).toMatchObject({ id: itemIdFor('4.10', item.description), code: '4.10', source: 'manual', active: true, updatedBy: 'editor' });
      expect(audits(orgId).at(-1)).toMatchObject({ entity: 'itemLibrary', action: 'create', entityId: created.id });
      const dup = await http.post('/api/v1/library/items').set(auth('editor2')).send({ orgId, ...item, description: `  ${item.description} ` });
      expect(dup.status).toBe(409);
      expect((await http.post('/api/v1/library/items').set(auth('editor')).send({ orgId, ...item, code: 4.1 })).status).toBe(400);
      await http.post('/api/v1/library/items').set(auth('editor')).send({ orgId, ...item, code: '4.1', description: 'אחר' });
      await http.post('/api/v1/library/items').set(auth('editor')).send({ orgId, ...item, code: '9.01', chapter: '08', description: 'התקנת גופי התאורה בבית' });
    });

    it('list (viewer): q / chapter / active filters, paging; other org sees nothing; outsider 404', async () => {
      const all = LibraryItemPageSchema.parse((await http.get(`/api/v1/library/items?orgId=${orgId}`).set(auth('viewer'))).body);
      expect(all.items.map((i) => i.code).sort()).toEqual(['4.1', '4.10', '9.01']);
      expect(all.items.find((i) => i.code === '4.10')?.code).toBe('4.10');
      const q = LibraryItemPageSchema.parse((await http.get(`/api/v1/library/items?orgId=${orgId}&q=${encodeURIComponent('מחליפים')}`).set(auth('viewer'))).body);
      expect(q.items.map((i) => i.code)).toEqual(['4.10']);
      const ch = LibraryItemPageSchema.parse((await http.get(`/api/v1/library/items?orgId=${orgId}&chapter=08`).set(auth('viewer'))).body);
      expect(ch.items.map((i) => i.code)).toEqual(['9.01']);
      const p1 = LibraryItemPageSchema.parse((await http.get(`/api/v1/library/items?orgId=${orgId}&limit=2`).set(auth('viewer'))).body);
      const p2 = LibraryItemPageSchema.parse((await http.get(`/api/v1/library/items?orgId=${orgId}&limit=2&cursor=${p1.nextCursor}`).set(auth('viewer'))).body);
      expect(p1.items.length + p2.items.length).toBe(3);
      expect(p2.nextCursor).toBeNull();
      expect((await http.get(`/api/v1/library/items?orgId=${orgId}`).set(auth('outsider'))).status).toBe(404);
      expect(LibraryItemPageSchema.parse((await http.get(`/api/v1/library/items?orgId=${otherOrg}`).set(auth('outsider'))).body).items).toEqual([]);
      expect((await http.get('/api/v1/library/items').set(auth('viewer'))).status).toBe(400);
    });

    it('patch (editor): unit/tags/active, audited; identity fields rejected; cross-org 404', async () => {
      const id = itemIdFor('4.10', item.description);
      const r = await http.patch(`/api/v1/library/items/${id}?orgId=${orgId}`).set(auth('editor')).send({ active: false, tags: ['תאורה', 'מחליף'] });
      expect(r.status).toBe(200);
      expect(ItemLibraryItemSchema.parse(r.body)).toMatchObject({ active: false, tags: ['תאורה', 'מחליף'] });
      expect(audits(orgId).at(-1)).toMatchObject({ entity: 'itemLibrary', action: 'update', entityId: id });
      expect((await http.patch(`/api/v1/library/items/${id}?orgId=${orgId}`).set(auth('editor')).send({ description: 'x' })).status).toBe(400);
      expect((await http.patch(`/api/v1/library/items/${id}?orgId=${orgId}`).set(auth('reviewer')).send({ active: true })).status).toBe(403);
      expect((await http.patch(`/api/v1/library/items/${id}?orgId=${otherOrg}`).set(auth('editor')).send({ active: true })).status).toBe(404);
      expect((await http.patch(`/api/v1/library/items/${id}?orgId=${otherOrg}`).set(auth('outsider')).send({ active: true })).status).toBe(404); // not in their org
      expect((await http.patch(`/api/v1/library/items/nope?orgId=${orgId}`).set(auth('editor')).send({ active: true })).status).toBe(404);
      const active = LibraryItemPageSchema.parse((await http.get(`/api/v1/library/items?orgId=${orgId}&active=true`).set(auth('viewer'))).body);
      expect(active.items.map((i) => i.code).sort()).toEqual(['4.1', '9.01']);
    });
  });

  describe('imports', () => {
    const create = async (who: string, filename: string, extra: Record<string, unknown> = {}) => {
      const r = await http.post('/api/v1/library/imports').set(auth(who)).send({ orgId, filename, sizeBytes: 1000, ...extra });
      return r;
    };
    const finalize = (who: string, id: string, org = orgId) => http.post(`/api/v1/library/imports/${id}/finalize`).set(auth(who)).send({ orgId: org });

    it('create: editor only; path orgs/{o}/imports/{uuid}.{ext}; bad extension / size 400; foreign project 404', async () => {
      for (const who of ['viewer', 'reviewer']) expect((await create(who, 'boq.xls')).status).toBe(403);
      expect((await create('editor', 'boq.pdf')).status).toBe(400);
      expect((await create('editor', 'boq.xlsx', { sizeBytes: 50 * 1024 * 1024 })).status).toBe(400);
      const otherProject = (await t.repo.createProject(otherOrg, { name: 'Q' }, 'outsider')).id;
      expect((await create('editor', 'boq.xlsx', { projectId: otherProject })).status).toBe(404);
      const r = await create('editor', '../../כתב כמויות נח.XLSX', { projectId });
      expect(r.status).toBe(201);
      const body = CreateLibraryImportResponseSchema.parse(r.body);
      expect(body.storagePath).toBe(storagePaths.libraryImport(orgId, body.import.id, 'xlsx'));
      expect(body.contentType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      expect(body.import).toMatchObject({ status: 'awaiting_upload', sourceKind: 'xlsx', projectId, originalName: 'כתב כמויות נח.XLSX', jobId: null });
    });

    it('finalize xlsx: magic bytes OK → job + library.import message + audit; idempotent; GET shows job', async () => {
      const c = CreateLibraryImportResponseSchema.parse((await create('editor', 'boq.xlsx')).body);
      t.boqStorage.putImport(c.storagePath, await xlsxBytes());
      expect((await finalize('editor2', c.import.id)).status).toBe(403); // only the uploader
      const before = t.queue.messages.length;
      const r = await finalize('editor', c.import.id);
      expect(r.status).toBe(202);
      const view = LibraryImportViewSchema.parse(r.body);
      expect(view).toMatchObject({ status: 'queued', job: { status: 'queued' } });
      const msg = t.queue.messages.at(-1);
      expect(t.queue.messages.length).toBe(before + 1);
      expect(msg?.attributes).toMatchObject({ type: 'library.import', orgId, jobId: view.jobId });
      expect(LibraryImportJobSchema.parse(msg?.data)).toMatchObject({ importId: c.import.id, sourceKind: 'xlsx', storagePath: c.storagePath, projectId: null });
      expect(t.repo.docs.get(fsPaths.job(view.jobId as string))).toMatchObject({ type: 'library.import', orgId, importId: c.import.id, status: 'queued' });
      expect(audits(orgId).at(-1)).toMatchObject({ entity: 'libraryImports', action: 'finalize', entityId: c.import.id });
      // idempotent
      expect(LibraryImportViewSchema.parse((await finalize('editor', c.import.id)).body).jobId).toBe(view.jobId);
      expect(t.queue.messages.length).toBe(before + 1);
      // worker progress visible through GET
      t.repo.docs.set(fsPaths.job(view.jobId as string), { ...(t.repo.docs.get(fsPaths.job(view.jobId as string)) as Doc), status: 'succeeded', progress: { stage: 'done', pct: 100 } });
      const g = LibraryImportViewSchema.parse((await http.get(`/api/v1/library/imports/${c.import.id}?orgId=${orgId}`).set(auth('viewer'))).body);
      expect(g.job).toMatchObject({ status: 'succeeded', progress: { pct: 100 } });
      expect((await http.get(`/api/v1/library/imports/${c.import.id}?orgId=${orgId}`).set(auth('outsider'))).status).toBe(404);
      expect((await http.get(`/api/v1/library/imports/${c.import.id}?orgId=${otherOrg}`).set(auth('outsider'))).status).toBe(404);
    });

    it('finalize xls (OLE CFB) → queued', async () => {
      const c = CreateLibraryImportResponseSchema.parse((await create('editor', 'old.xls')).body);
      t.boqStorage.putImport(c.storagePath, XLS_BYTES);
      expect(LibraryImportViewSchema.parse((await finalize('editor', c.import.id)).body).status).toBe('queued');
    });

    it('wrong content → 415, object deleted, import rejected, no job', async () => {
      for (const [name, bytes] of [['a.xls', SAMPLE.pdf], ['b.xlsx', XLS_BYTES], ['c.xls', Buffer.from('PK\x03\x04 not really')]] as const) {
        const c = CreateLibraryImportResponseSchema.parse((await create('editor', name)).body);
        t.boqStorage.putImport(c.storagePath, bytes as Buffer);
        const before = t.queue.messages.length;
        const r = await finalize('editor', c.import.id);
        expect(r.status).toBe(415);
        expect(ApiErrorSchema.parse(r.body).error.code).toBe('unsupported_file_type');
        expect(t.boqStorage.objects.has(c.storagePath)).toBe(false);
        expect(t.queue.messages.length).toBe(before);
        const g = LibraryImportViewSchema.parse((await http.get(`/api/v1/library/imports/${c.import.id}?orgId=${orgId}`).set(auth('editor'))).body);
        expect(g).toMatchObject({ status: 'rejected', jobId: null, error: { code: 'unsupported_file_type' } });
      }
    });

    it('missing object 409, expired slot 410, too large 413, bad id 404, cross-org finalize 404', async () => {
      const c = CreateLibraryImportResponseSchema.parse((await create('editor', 'x.xlsx')).body);
      const missing = await finalize('editor', c.import.id);
      expect(missing.status).toBe(409);
      expect(ApiErrorSchema.parse(missing.body).error.code).toBe('upload_missing');

      const e = CreateLibraryImportResponseSchema.parse((await create('editor', 'e.xlsx')).body);
      t.boqStorage.putImport(e.storagePath, await xlsxBytes());
      const p = fsPaths.libraryImport(orgId, e.import.id);
      t.repo.docs.set(p, { ...(t.repo.docs.get(p) as Doc), expiresAt: new Date(Date.now() - 1000) });
      expect((await finalize('editor', e.import.id)).status).toBe(410);
      expect(t.boqStorage.objects.has(e.storagePath)).toBe(false);

      const big = CreateLibraryImportResponseSchema.parse((await create('editor', 'big.xlsx')).body);
      t.boqStorage.putImport(big.storagePath, Buffer.alloc(20 * 1024 * 1024 + 1));
      expect((await finalize('editor', big.import.id)).status).toBe(413);

      expect((await finalize('editor', 'not-a-uuid')).status).toBe(404);
      expect((await finalize('outsider', c.import.id, otherOrg)).status).toBe(404);
      expect((await finalize('outsider', c.import.id)).status).toBe(404);
    });

    it('publish failure → 503 and the import is failed', async () => {
      const c = CreateLibraryImportResponseSchema.parse((await create('editor', 'p.xlsx')).body);
      t.boqStorage.putImport(c.storagePath, await xlsxBytes());
      const orig = t.queue.publish.bind(t.queue);
      t.queue.publish = async () => {
        throw new Error('down');
      };
      try {
        expect((await finalize('editor', c.import.id)).status).toBe(503);
      } finally {
        t.queue.publish = orig;
      }
      const g = LibraryImportViewSchema.parse((await http.get(`/api/v1/library/imports/${c.import.id}?orgId=${orgId}`).set(auth('editor'))).body);
      expect(g).toMatchObject({ status: 'failed', error: { code: 'publish_failed' }, job: { status: 'failed' } });
    });
  });

  describe('templates', () => {
    it('GET seeds the default template from the sample (once); editor PATCH 403; admin PATCH audited', async () => {
      const r = await http.get(`/api/v1/boq-templates?orgId=${orgId}`).set(auth('viewer'));
      expect(r.status).toBe(200);
      const list = BoqTemplateListSchema.parse(r.body);
      expect(list.items).toHaveLength(1);
      const tpl = list.items[0];
      expect(tpl).toMatchObject({ id: 'tpl_default', default: true, source: 'default', vatRate: 0.18 });
      expect(tpl?.chapters.find((c) => c.code === '04')?.title).toBe('פרק 04 – עבודות חשמל');
      expect(tpl?.columns.map((c) => c.title)).toEqual(['סעיף', 'תאור העבודה', 'יחידה', 'כמות סה"כ', "מחיר יח'", 'סה"כ ₪']);
      expect(BoqTemplateListSchema.parse((await http.get(`/api/v1/boq-templates?orgId=${orgId}`).set(auth('viewer'))).body).items).toHaveLength(1);

      expect((await http.patch(`/api/v1/boq-templates/tpl_default?orgId=${orgId}`).set(auth('editor')).send({ name: 'x' })).status).toBe(403);
      expect((await http.patch(`/api/v1/boq-templates/tpl_default?orgId=${orgId}`).set(auth('outsider')).send({ name: 'x' })).status).toBe(404);
      const p = await http.patch(`/api/v1/boq-templates/tpl_default?orgId=${orgId}`).set(auth('admin')).send({ titleRows: ['כתב כמויות', '{projectName} — {date}'] });
      expect(p.status).toBe(200);
      expect(BoqTemplateSchema.parse(p.body).titleRows).toEqual(['כתב כמויות', '{projectName} — {date}']);
      expect(audits(orgId).at(-1)).toMatchObject({ entity: 'boqTemplates', action: 'update', entityId: 'tpl_default' });
      expect((await http.patch(`/api/v1/boq-templates/tpl_default?orgId=${orgId}`).set(auth('admin')).send({ columns: [{ key: 'code', title: 'סעיף' }] })).status).toBe(400);
      expect((await http.patch(`/api/v1/boq-templates/nope?orgId=${orgId}`).set(auth('admin')).send({ name: 'x' })).status).toBe(404);
    });

    it('default switching: an imported template made default unsets the seeded one', async () => {
      const tplPath = fsPaths.boqTemplate(orgId, 'tpl_import1');
      t.repo.docs.set(tplPath, { ...(t.repo.docs.get(fsPaths.boqTemplate(orgId, 'tpl_default')) as Doc), name: 'מיובא', default: false, source: 'import' });
      const r = await http.patch(`/api/v1/boq-templates/tpl_import1?orgId=${orgId}`).set(auth('admin')).send({ default: true });
      expect(r.status).toBe(200);
      const list = BoqTemplateListSchema.parse((await http.get(`/api/v1/boq-templates?orgId=${orgId}`).set(auth('viewer'))).body);
      expect(list.items.filter((x) => x.default).map((x) => x.id)).toEqual(['tpl_import1']);
      expect((await http.patch(`/api/v1/boq-templates/tpl_import1?orgId=${orgId}`).set(auth('admin')).send({ default: false })).status).toBe(400);
    });
  });

  describe('rules', () => {
    it('GET seeds the default rule set; viewer reads; admin PATCH (enabled/priority/itemCode) audited with before/after', async () => {
      const list = BoqRuleListSchema.parse((await http.get(`/api/v1/boq-rules?orgId=${orgId}`).set(auth('viewer'))).body);
      expect(list.items.length).toBeGreaterThan(20);
      const two = list.items.find((r) => r.id === 'r_light_two_way');
      expect(two).toMatchObject({ kind: 'composite_lighting', itemCode: '4.10', enabled: true, match: { groupKind: 'two_way', pointCount: 1 } });
      expect((await http.patch(`/api/v1/boq-rules/r_light_two_way?orgId=${orgId}`).set(auth('editor')).send({ enabled: false })).status).toBe(403);
      expect((await http.patch(`/api/v1/boq-rules/r_light_two_way?orgId=${orgId}`).set(auth('admin')).send({ match: {} })).status).toBe(400);
      const r = await http.patch(`/api/v1/boq-rules/r_light_two_way?orgId=${orgId}`).set(auth('admin')).send({ enabled: false, priority: 250, itemCode: '4.10' });
      expect(r.status).toBe(200);
      expect(BoqRuleSchema.parse(r.body)).toMatchObject({ enabled: false, priority: 250, itemCode: '4.10', updatedBy: 'admin', source: 'user' });
      expect(audits(orgId).at(-1)).toMatchObject({ entity: 'boqRules', action: 'update', entityId: 'r_light_two_way', after: { enabled: { from: true, to: false }, priority: { from: 200, to: 250 } } });
      expect((await http.patch(`/api/v1/boq-rules/nope?orgId=${orgId}`).set(auth('admin')).send({ enabled: false })).status).toBe(404);
      expect((await http.patch(`/api/v1/boq-rules/r_light_two_way?orgId=${otherOrg}`).set(auth('admin')).send({ enabled: true })).status).toBe(404);
    });

    it('reseed: outdated shipped defaults are replaced, user-edited rules never touched, missing ones created', async () => {
      const old = fsPaths.boqRule(orgId, 'r_install_luminaires');
      t.repo.docs.set(old, { ...(t.repo.docs.get(old) as Doc), defaultsVersion: undefined, match: { classes: ['luminaire_wall'], excludeClasses: [], excludeSupply: ['client'], excludeLifecycle: ['existing'] } });
      t.repo.docs.delete(fsPaths.boqRule(orgId, 'r_none_breaker'));
      const list = BoqRuleListSchema.parse((await http.get(`/api/v1/boq-rules?orgId=${orgId}`).set(auth('viewer'))).body);
      expect(list.items.find((r) => r.id === 'r_install_luminaires')).toMatchObject({ source: 'default', defaultsVersion: DEFAULT_BOQ_RULES_VERSION, match: { excludeSupply: [], excludeLifecycle: ['demolish'] } });
      expect(list.items.find((r) => r.id === 'r_none_breaker')).toMatchObject({ itemCode: null, source: 'default' });
      expect(list.items.find((r) => r.id === 'r_light_two_way')).toMatchObject({ source: 'user', enabled: false, priority: 250 });
      // a stale user rule survives an explicit reseed too
      const two = fsPaths.boqRule(orgId, 'r_light_two_way');
      t.repo.docs.set(two, { ...(t.repo.docs.get(two) as Doc), defaultsVersion: 0 });
      await t.boq.seedDefaults(orgId);
      expect(t.repo.docs.get(two)).toMatchObject({ source: 'user', enabled: false, priority: 250 });
    });

    it('org bootstrap seeds defaults (POST /orgs)', async () => {
      const tokNew = t.auth.issue('founder');
      const r = await http.post('/api/v1/orgs').set({ authorization: `Bearer ${tokNew}` }).send({ name: 'חדש' });
      expect(r.status).toBe(201);
      const id = (r.body as { id: string }).id;
      expect(t.repo.docs.has(fsPaths.boqTemplate(id, 'tpl_default'))).toBe(true);
      expect(t.repo.docs.has(fsPaths.boqRule(id, 'r_install_luminaires'))).toBe(true);
    });
  });
});
