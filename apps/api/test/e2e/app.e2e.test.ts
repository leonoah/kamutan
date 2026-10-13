import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiErrorSchema, FinalizeUploadResponseSchema, ProjectSchema } from '@kamutan/contracts';
import { createTestApp, type TestApp } from '../support/app';
import { SAMPLE, testConfig } from '../support/helpers';

describe('Kamutan API e2e (/api/v1, fake auth + in-memory Firestore/Storage/PubSub)', () => {
  let t: TestApp;
  let http: ReturnType<typeof request>;
  const tok: Record<string, string> = {};
  let orgId: string;
  let otherOrgId: string;
  let projectId: string;

  const auth = (who: string) => ({ authorization: `Bearer ${tok[who]}` });

  beforeAll(async () => {
    t = await createTestApp(testConfig({ UPLOAD_THROTTLE_LIMIT: '100', THROTTLE_LIMIT: '1000' }));
    http = request(t.app.getHttpServer());
    for (const who of ['admin', 'editor', 'viewer', 'outsider']) tok[who] = t.auth.issue(who);
    tok.adminMfa = t.auth.issue('admin', { mfa: true });
    orgId = t.repo.seedOrg('משרד א', { admin: 'admin', editor: 'editor', viewer: 'viewer' }).id;
    otherOrgId = t.repo.seedOrg('Office B', { outsider: 'admin' }).id;
  });

  afterAll(async () => {
    await t?.app.close();
  });

  describe('health & hardening', () => {
    it('GET /api/v1/health is public, with security headers and a request id', async () => {
      const res = await http.get('/api/v1/health').expect(200);
      expect(res.body).toMatchObject({ status: 'ok' });
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('routes are only served under /api/v1', async () => {
      await http.get('/v1/health').expect(404);
    });

    it('propagates a well-formed X-Request-Id', async () => {
      const res = await http.get('/api/v1/health').set('x-request-id', 'req-12345678').expect(200);
      expect(res.headers['x-request-id']).toBe('req-12345678');
    });

    it('readiness reports dependencies', async () => {
      expect((await http.get('/api/v1/health/ready').expect(200)).body.checks).toEqual({ db: 'ok', queue: 'ok' });
    });

    it('same-origin by default: no CORS headers for foreign origins', async () => {
      const res = await http.options('/api/v1/me').set('origin', 'https://evil.example').set('access-control-request-method', 'GET');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('auth', () => {
    it('401 with the contract error shape when the token is missing/invalid/revoked', async () => {
      const res = await http.get('/api/v1/me').expect(401);
      expect(ApiErrorSchema.parse(res.body).error.code).toBe('unauthorized');
      expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
      await http.get('/api/v1/me').set('authorization', 'Bearer abc.def.ghi').expect(401);
      const revoked = t.auth.issue('editor');
      t.auth.revoke(revoked);
      await http.get('/api/v1/me').set('authorization', `Bearer ${revoked}`).expect(401);
      const anon = t.auth.issue('anon-user', { provider: 'anonymous' });
      await http.get('/api/v1/me').set('authorization', `Bearer ${anon}`).expect(401);
    });

    it('GET /api/v1/me lists my orgs, roles and MFA state', async () => {
      const res = await http.get('/api/v1/me').set(auth('editor')).expect(200);
      expect(res.body).toMatchObject({ uid: 'editor', mfa: false, orgs: [{ id: orgId, role: 'editor' }] });
      expect((await http.get('/api/v1/me').set(auth('adminMfa')).expect(200)).body.mfa).toBe(true);
    });
  });

  describe('orgs', () => {
    it('POST /api/v1/orgs makes the creator admin (members/{uid}) and audits it', async () => {
      const token = t.auth.issue('founder');
      const res = await http.post('/api/v1/orgs').set('authorization', `Bearer ${token}`).send({ name: 'New' }).expect(201);
      expect(res.body.settings).toMatchObject({ llmEnabled: false });
      expect(t.repo.docs.get(`orgs/${res.body.id}/members/founder`)).toMatchObject({ uid: 'founder', role: 'admin' });
      const me = await http.get('/api/v1/me').set('authorization', `Bearer ${token}`).expect(200);
      expect(me.body.orgs).toEqual([expect.objectContaining({ id: res.body.id, role: 'admin' })]);
    });

    it('validates input with the contract schema', async () => {
      const res = await http.post('/api/v1/orgs').set(auth('editor')).send({ name: '', extra: 1 }).expect(400);
      expect(res.body.error.code).toBe('validation_failed');
    });

    it('GET /api/v1/orgs/:id: members only (404 for outsiders)', async () => {
      await http.get(`/api/v1/orgs/${orgId}`).set(auth('viewer')).expect(200);
      await http.get(`/api/v1/orgs/${orgId}`).set(auth('outsider')).expect(404);
    });
  });

  describe('projects', () => {
    it('editor creates; viewer 403; outsider 404; bad body 400', async () => {
      const res = await http.post('/api/v1/projects').set(auth('editor')).send({ orgId, name: 'בית משפחת נח' }).expect(201);
      const project = ProjectSchema.parse(res.body);
      expect(project).toMatchObject({ orgId, status: 'active', createdBy: 'editor', floors: [] });
      projectId = project.id;
      expect(t.repo.docs.get(`orgs/${orgId}/projects/${projectId}`)).toMatchObject({ projectId, orgId });

      await http.post('/api/v1/projects').set(auth('viewer')).send({ orgId, name: 'x' }).expect(403);
      await http.post('/api/v1/projects').set(auth('outsider')).send({ orgId, name: 'x' }).expect(404);
      await http.post('/api/v1/projects').set(auth('editor')).send({ name: 'x' }).expect(400);
    });

    it('lists one org with cursor pagination; orgId required; isolation', async () => {
      for (let i = 0; i < 3; i++) await http.post('/api/v1/projects').set(auth('editor')).send({ orgId, name: `P${i}` }).expect(201);
      await http.post('/api/v1/projects').set(auth('outsider')).send({ orgId: otherOrgId, name: 'foreign' }).expect(201);

      await http.get('/api/v1/projects').set(auth('viewer')).expect(400);
      await http.get('/api/v1/projects').query({ orgId: otherOrgId }).set(auth('viewer')).expect(404);
      const p1 = await http.get('/api/v1/projects').query({ orgId, limit: 2 }).set(auth('viewer')).expect(200);
      expect(p1.body.items).toHaveLength(2);
      const p2 = await http.get('/api/v1/projects').query({ orgId, limit: 2, cursor: p1.body.nextCursor }).set(auth('viewer')).expect(200);
      expect(p2.body.nextCursor).toBeNull();
      const names = [...p1.body.items, ...p2.body.items].map((p: { name: string }) => p.name);
      expect(new Set(names).size).toBe(4);
      expect(names).not.toContain('foreign');
    });

    it('GET/PATCH by id with role and isolation checks', async () => {
      await http.get(`/api/v1/projects/${projectId}`).set(auth('viewer')).expect(200);
      await http.get(`/api/v1/projects/${projectId}`).set(auth('outsider')).expect(404);
      await http.get('/api/v1/projects/nope').set(auth('admin')).expect(404);
      await http.patch(`/api/v1/projects/${projectId}`).set(auth('viewer')).send({ name: 'x' }).expect(403);
      await http.patch(`/api/v1/projects/${projectId}`).set(auth('outsider')).send({ name: 'x' }).expect(404);
      await http.patch(`/api/v1/projects/${projectId}`).set(auth('editor')).send({}).expect(400);
      await http.patch(`/api/v1/projects/${projectId}`).set(auth('editor')).send({ status: 'deleted' }).expect(400);
      const res = await http.patch(`/api/v1/projects/${projectId}`).set(auth('editor')).send({ address: 'רחוב הדוגמה 1' }).expect(200);
      expect(res.body.address).toBe('רחוב הדוגמה 1');
    });
  });

  describe('uploads (reserve → direct Storage upload → finalize)', () => {
    async function reserve(filename: string, body: Buffer, who = 'editor') {
      const res = await http.post(`/api/v1/projects/${projectId}/uploads`).set(auth(who)).send({ filename, sizeBytes: body.length }).expect(201);
      t.storage.put(res.body.storagePath, body, res.body.contentType); // stands in for the Firebase JS SDK resumable upload
      return res.body as { uploadToken: string; storagePath: string; fileId: string };
    }

    it('full flow publishes ingest; re-upload dedupes', async () => {
      const up = await reserve('חשמל - קומת קרקע.pdf', SAMPLE.pdf);
      expect(up.storagePath).toBe(`orgs/${orgId}/quarantine/${up.fileId}`);
      const res = await http
        .post(`/api/v1/projects/${projectId}/sheet-sets`)
        .set(auth('editor'))
        .set('traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')
        .send({ uploadToken: up.uploadToken })
        .expect(201);
      const body = FinalizeUploadResponseSchema.parse(res.body);
      expect(body).toMatchObject({ deduplicated: false, sheetSet: { name: 'חשמל - קומת קרקע.pdf', status: 'queued' } });
      expect(t.queue.messages.at(-1)?.data).toMatchObject({ schemaVersion: 3, jobId: body.jobId, orgId, versionId: body.versionId, sheetId: null });
      expect(t.storage.objects.has(up.storagePath)).toBe(false);
      expect(t.storage.objects.has(body.sheetSet.storagePath)).toBe(true);

      const before = t.queue.messages.length;
      const again = await reserve('renamed.pdf', SAMPLE.pdf);
      const r2 = await http.post(`/api/v1/projects/${projectId}/sheet-sets`).set(auth('editor')).send({ uploadToken: again.uploadToken }).expect(201);
      expect(r2.body).toMatchObject({ deduplicated: true, jobId: body.jobId });
      expect(t.queue.messages.length).toBe(before);
    });

    it('rejects spoofed content (415), bad extensions and oversize declarations (400)', async () => {
      const up = await reserve('evil.pdf', Buffer.from('<script>alert(1)</script>'));
      const res = await http.post(`/api/v1/projects/${projectId}/sheet-sets`).set(auth('editor')).send({ uploadToken: up.uploadToken }).expect(415);
      expect(res.body.error.code).toBe('unsupported_file_type');
      await http.post(`/api/v1/projects/${projectId}/uploads`).set(auth('editor')).send({ filename: 'a.exe', sizeBytes: 10 }).expect(400);
      await http.post(`/api/v1/projects/${projectId}/uploads`).set(auth('editor')).send({ filename: 'a.pdf', sizeBytes: 100 * 1024 * 1024 + 1 }).expect(400);
    });

    it('enforces roles and tenancy', async () => {
      await http.post(`/api/v1/projects/${projectId}/uploads`).set(auth('viewer')).send({ filename: 'a.pdf', sizeBytes: 10 }).expect(403);
      await http.post(`/api/v1/projects/${projectId}/uploads`).set(auth('outsider')).send({ filename: 'a.pdf', sizeBytes: 10 }).expect(404);
      const up = await reserve('a.pdf', SAMPLE.pdf);
      await http.post(`/api/v1/projects/${projectId}/sheet-sets`).set(auth('outsider')).send({ uploadToken: up.uploadToken }).expect(404);
      await http.post(`/api/v1/projects/${projectId}/sheet-sets`).set(auth('admin')).send({ uploadToken: up.uploadToken }).expect(400);
    });
  });

  describe('rate limiting', () => {
    it('429 with the contract error shape after the per-user upload limit; other users unaffected', async () => {
      const limited = await createTestApp(testConfig({ UPLOAD_THROTTLE_LIMIT: '2' }));
      try {
        const h = request(limited.app.getHttpServer());
        const o = limited.repo.seedOrg('R', { u1: 'editor', u2: 'editor' });
        const p = await limited.repo.createProject(o.id, { name: 'p' }, 'u1');
        const t1 = `Bearer ${limited.auth.issue('u1')}`;
        const send = (tk: string) => h.post(`/api/v1/projects/${p.id}/uploads`).set('authorization', tk).send({ filename: 'a.pdf', sizeBytes: 1 });
        await send(t1).expect(201);
        await send(t1).expect(201);
        expect((await send(t1).expect(429)).body.error.code).toBe('rate_limited');
        await send(`Bearer ${limited.auth.issue('u2')}`).expect(201);
      } finally {
        await limited.app.close();
      }
    });
  });
});
