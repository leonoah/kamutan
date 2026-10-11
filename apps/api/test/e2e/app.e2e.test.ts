import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiErrorSchema, FinalizeUploadResponseSchema, ProjectSchema } from '@kamutan/contracts';
import { createTestApp, type TestApp } from '../support/app';
import { makeToken, SAMPLE, testConfig } from '../support/helpers';

describe('Kamutan API (e2e: fake repository + in-memory queue + local storage)', () => {
  let t: TestApp;
  let http: ReturnType<typeof request>;
  const admin = randomUUID();
  const editor = randomUUID();
  const viewer = randomUUID();
  const outsider = randomUUID();
  const tok: Record<string, string> = {};
  let orgId: string;
  let otherOrgId: string;
  let projectId: string;

  const auth = (who: string) => ({ authorization: `Bearer ${tok[who]}` });

  beforeAll(async () => {
    t = await createTestApp(testConfig({ UPLOAD_THROTTLE_LIMIT: '50', THROTTLE_LIMIT: '1000' }));
    http = request(t.app.getHttpServer());
    for (const [k, v] of Object.entries({ admin, editor, viewer, outsider })) tok[k] = await makeToken(v);
    orgId = t.repo.seedOrg({ name: 'משרד א', slug: 'office-a' }, { [admin]: 'admin', [editor]: 'editor', [viewer]: 'viewer' }).id;
    otherOrgId = t.repo.seedOrg({ name: 'Office B', slug: 'office-b' }, { [outsider]: 'admin' }).id;
  });

  afterAll(async () => {
    await t?.app.close();
  });

  describe('health & hardening', () => {
    it('GET /v1/health is public and sets security headers + request id', async () => {
      const res = await http.get('/v1/health').expect(200);
      expect(res.body).toMatchObject({ status: 'ok' });
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['strict-transport-security']).toContain('max-age=');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('propagates a well-formed X-Request-Id', async () => {
      const res = await http.get('/v1/health').set('x-request-id', 'req-12345678').expect(200);
      expect(res.headers['x-request-id']).toBe('req-12345678');
    });

    it('GET /v1/health/ready checks dependencies', async () => {
      const res = await http.get('/v1/health/ready').expect(200);
      expect(res.body.checks).toEqual({ db: 'ok', queue: 'ok' });
    });

    it('CORS allows only configured origins', async () => {
      const ok = await http.options('/v1/projects').set('origin', 'http://localhost:5173').set('access-control-request-method', 'GET');
      expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      const bad = await http.options('/v1/projects').set('origin', 'https://evil.example').set('access-control-request-method', 'GET');
      expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('auth', () => {
    it('401 with the contract error shape when the token is missing/invalid', async () => {
      const res = await http.get('/v1/me').expect(401);
      expect(ApiErrorSchema.parse(res.body).error.code).toBe('unauthorized');
      expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
      await http.get('/v1/me').set('authorization', 'Bearer abc.def.ghi').expect(401);
      const service = await makeToken(admin, { role: 'service_role' });
      await http.get('/v1/me').set('authorization', `Bearer ${service}`).expect(401);
    });

    it('GET /v1/me lists my orgs and roles', async () => {
      const res = await http.get('/v1/me').set(auth('editor')).expect(200);
      expect(res.body).toMatchObject({ userId: editor, aal: 'aal1', orgs: [{ id: orgId, role: 'editor' }] });
    });
  });

  describe('orgs', () => {
    it('POST /v1/orgs makes the creator admin; duplicate slug → 409', async () => {
      const u = randomUUID();
      const token = await makeToken(u);
      const res = await http.post('/v1/orgs').set('authorization', `Bearer ${token}`).send({ name: 'New', slug: 'new-org' }).expect(201);
      const me = await http.get('/v1/me').set('authorization', `Bearer ${token}`).expect(200);
      expect(me.body.orgs).toEqual([expect.objectContaining({ id: res.body.id, role: 'admin' })]);
      await http.post('/v1/orgs').set('authorization', `Bearer ${token}`).send({ name: 'Dup', slug: 'new-org' }).expect(409);
    });

    it('validates input with the contract schema', async () => {
      const res = await http.post('/v1/orgs').set(auth('editor')).send({ name: '', slug: 'Bad Slug!', extra: 1 }).expect(400);
      expect(res.body.error.code).toBe('validation_failed');
      expect(res.body.error.issues.length).toBeGreaterThan(0);
    });

    it('GET /v1/orgs/:id: members only (404 for outsiders)', async () => {
      await http.get(`/v1/orgs/${orgId}`).set(auth('viewer')).expect(200);
      await http.get(`/v1/orgs/${orgId}`).set(auth('outsider')).expect(404);
    });
  });

  describe('projects', () => {
    it('editor creates a project; viewer cannot (403); outsider org → 404', async () => {
      const res = await http.post('/v1/projects').set(auth('editor')).send({ orgId, name: 'בית משפחת נח', address: null }).expect(201);
      const project = ProjectSchema.parse(res.body);
      expect(project).toMatchObject({ orgId, name: 'בית משפחת נח', status: 'active', createdBy: editor });
      projectId = project.id;

      await http.post('/v1/projects').set(auth('viewer')).send({ orgId, name: 'x' }).expect(403);
      await http.post('/v1/projects').set(auth('outsider')).send({ orgId, name: 'x' }).expect(404);
      await http.post('/v1/projects').set(auth('editor')).send({ orgId: 'not-a-uuid', name: 'x' }).expect(400);
    });

    it('lists with cursor pagination, scoped to my orgs', async () => {
      for (let i = 0; i < 3; i++) {
        await http.post('/v1/projects').set(auth('editor')).send({ orgId, name: `P${i}` }).expect(201);
      }
      await http.post('/v1/projects').set(auth('outsider')).send({ orgId: otherOrgId, name: 'foreign' }).expect(201);

      const page1 = await http.get('/v1/projects').query({ limit: 2 }).set(auth('viewer')).expect(200);
      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.nextCursor).toEqual(expect.any(String));
      const page2 = await http.get('/v1/projects').query({ limit: 2, cursor: page1.body.nextCursor }).set(auth('viewer')).expect(200);
      expect(page2.body.items).toHaveLength(2);
      expect(page2.body.nextCursor).toBeNull();
      const names = [...page1.body.items, ...page2.body.items].map((p: { name: string }) => p.name);
      expect(names).not.toContain('foreign');
      expect(new Set(names).size).toBe(4);
    });

    it('GET/PATCH by id with role and isolation checks', async () => {
      await http.get(`/v1/projects/${projectId}`).set(auth('viewer')).expect(200);
      await http.get(`/v1/projects/${projectId}`).set(auth('outsider')).expect(404);
      await http.get(`/v1/projects/${randomUUID()}`).set(auth('admin')).expect(404);
      await http.get('/v1/projects/not-a-uuid').set(auth('admin')).expect(404);

      await http.patch(`/v1/projects/${projectId}`).set(auth('viewer')).send({ name: 'x' }).expect(403);
      await http.patch(`/v1/projects/${projectId}`).set(auth('outsider')).send({ name: 'x' }).expect(404);
      await http.patch(`/v1/projects/${projectId}`).set(auth('editor')).send({}).expect(400);
      await http.patch(`/v1/projects/${projectId}`).set(auth('editor')).send({ status: 'deleted' }).expect(400);
      const res = await http.patch(`/v1/projects/${projectId}`).set(auth('editor')).send({ address: 'רחוב הדוגמה 1' }).expect(200);
      expect(res.body.address).toBe('רחוב הדוגמה 1');
    });
  });

  describe('uploads (create → PUT → finalize)', () => {
    async function uploadFile(filename: string, body: Buffer, who = 'editor') {
      const created = await http
        .post(`/v1/projects/${projectId}/uploads`)
        .set(auth(who))
        .send({ filename, sizeBytes: body.length })
        .expect(201);
      const url = new URL(created.body.uploadUrl);
      await http.put(url.pathname).set('content-type', 'application/octet-stream').send(body).expect(200);
      return created.body as { uploadToken: string; storagePath: string };
    }

    it('full flow creates sheet set/version and enqueues ingest; re-upload dedupes', async () => {
      const up = await uploadFile('חשמל - קומת קרקע.pdf', SAMPLE.pdf);
      const res = await http
        .post(`/v1/projects/${projectId}/sheet-sets`)
        .set(auth('editor'))
        .set('traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')
        .send({ uploadToken: up.uploadToken })
        .expect(201);
      const body = FinalizeUploadResponseSchema.parse(res.body);
      expect(body.deduplicated).toBe(false);
      expect(body.sheetSet.name).toBe('חשמל - קומת קרקע.pdf');
      expect(body.sheetVersion.status).toBe('queued');
      expect(t.queue.jobs.at(-1)).toMatchObject({
        id: body.jobId,
        payload: {
          sheetVersionId: body.sheetVersion.id,
          orgId,
          storagePath: up.storagePath,
          sha256: body.sheetSet.sourceSha256,
          traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        },
      });

      const jobsBefore = t.queue.jobs.length;
      const again = await uploadFile('same-file-renamed.pdf', SAMPLE.pdf);
      const res2 = await http.post(`/v1/projects/${projectId}/sheet-sets`).set(auth('editor')).send({ uploadToken: again.uploadToken }).expect(201);
      expect(res2.body).toMatchObject({ deduplicated: true, jobId: body.jobId, sheetVersion: { id: body.sheetVersion.id } });
      expect(t.queue.jobs.length).toBe(jobsBefore);
    });

    it('accepts png, dxf and dwg by magic bytes', async () => {
      for (const [name, bytes] of [['a.png', SAMPLE.png], ['b.dxf', SAMPLE.dxf], ['c.dwg', SAMPLE.dwg]] as const) {
        const up = await uploadFile(name, bytes);
        const res = await http.post(`/v1/projects/${projectId}/sheet-sets`).set(auth('editor')).send({ uploadToken: up.uploadToken }).expect(201);
        expect(res.body.sheetSet.fileKind).toBe(name.split('.')[1]);
      }
    });

    it('rejects spoofed content (415), bad extensions and oversize declarations (400)', async () => {
      const up = await uploadFile('evil.pdf', Buffer.from('<script>alert(1)</script>'));
      const res = await http.post(`/v1/projects/${projectId}/sheet-sets`).set(auth('editor')).send({ uploadToken: up.uploadToken }).expect(415);
      expect(res.body.error.code).toBe('unsupported_file_type');

      await http.post(`/v1/projects/${projectId}/uploads`).set(auth('editor')).send({ filename: 'a.exe', sizeBytes: 10 }).expect(400);
      await http
        .post(`/v1/projects/${projectId}/uploads`)
        .set(auth('editor'))
        .send({ filename: 'a.pdf', sizeBytes: 100 * 1024 * 1024 + 1 })
        .expect(400);
    });

    it('enforces roles and tenancy on uploads', async () => {
      await http.post(`/v1/projects/${projectId}/uploads`).set(auth('viewer')).send({ filename: 'a.pdf', sizeBytes: 10 }).expect(403);
      await http.post(`/v1/projects/${projectId}/uploads`).set(auth('outsider')).send({ filename: 'a.pdf', sizeBytes: 10 }).expect(404);

      // A token minted for this project cannot be finalized by an admin of another org, nor by a different user.
      const up = await uploadFile('a.pdf', SAMPLE.pdf);
      await http.post(`/v1/projects/${projectId}/sheet-sets`).set(auth('outsider')).send({ uploadToken: up.uploadToken }).expect(404);
      await http.post(`/v1/projects/${projectId}/sheet-sets`).set(auth('admin')).send({ uploadToken: up.uploadToken }).expect(400);
    });

    it('local-storage PUT requires a valid signed token and enforces the size grant', async () => {
      await http.put('/v1/local-storage/forged.token').send(SAMPLE.pdf).expect(403);
      const created = await http
        .post(`/v1/projects/${projectId}/uploads`)
        .set(auth('editor'))
        .send({ filename: 'a.pdf', sizeBytes: 10 })
        .expect(201);
      const tokenPart = new URL(created.body.uploadUrl).pathname.split('/').pop() as string;
      const [body, sig] = tokenPart.split('.') as [string, string];
      const grant = JSON.parse(Buffer.from(body, 'base64url').toString());
      const tampered = Buffer.from(JSON.stringify({ ...grant, max: 1e12 })).toString('base64url');
      await http.put(`/v1/local-storage/${tampered}.${sig}`).send(SAMPLE.pdf).expect(403);
    });
  });

  describe('rate limiting', () => {
    it('returns 429 with the contract error shape after the per-user upload limit', async () => {
      const limited = await createTestApp(testConfig({ UPLOAD_THROTTLE_LIMIT: '2' }));
      try {
        const h = request(limited.app.getHttpServer());
        const u = randomUUID();
        const o = limited.repo.seedOrg({ name: 'R', slug: 'r' }, { [u]: 'editor' });
        const token = `Bearer ${await makeToken(u)}`;
        const p = await h.post('/v1/projects').set('authorization', token).send({ orgId: o.id, name: 'p' }).expect(201);
        const send = () => h.post(`/v1/projects/${p.body.id}/uploads`).set('authorization', token).send({ filename: 'a.pdf', sizeBytes: 1 });
        await send().expect(201);
        await send().expect(201);
        const res = await send().expect(429);
        expect(res.body.error.code).toBe('rate_limited');
        // Other users are unaffected (per-user tracker).
        const u2 = randomUUID();
        limited.repo.store.memberships.set(`${o.id}:${u2}`, 'editor');
        await h.post(`/v1/projects/${p.body.id}/uploads`).set('authorization', `Bearer ${await makeToken(u2)}`).send({ filename: 'a.pdf', sizeBytes: 1 }).expect(201);
      } finally {
        await limited.app.close();
      }
    });
  });
});
