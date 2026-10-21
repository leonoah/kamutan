import express from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { UPLOAD_SECRET } from '../support/helpers';

/** Drives the Cloud Functions handler the way the Functions framework does (express req/res). */
describe('Cloud Functions entry (src/function.ts)', () => {
  let server: express.Express;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATA_DRIVER: 'memory',
      STORAGE_DRIVER: 'memory',
      QUEUE_DRIVER: 'memory',
      UPLOAD_TOKEN_SECRET: UPLOAD_SECRET,
      SWAGGER_ENABLED: 'false',
    });
    const { api } = await import('../../src/function');
    server = express();
    server.use(express.json()); // the Functions framework pre-parses JSON bodies
    server.all('/{*splat}', (req, res) => api(req as never, res as never));
  });

  it('serves /api/v1/health and boots Nest once (cached)', async () => {
    const r1 = await request(server).get('/api/v1/health').expect(200);
    expect(r1.body.status).toBe('ok');
    await request(server).get('/api/v1/health').expect(200);
  });

  it('requires auth and handles pre-parsed JSON bodies', async () => {
    await request(server).get('/api/v1/me').expect(401);
    const res = await request(server).post('/api/v1/orgs').send({ name: 'x' }).expect(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('R-A8: api, apiJobs and reprocessDependents run as the API_SERVICE_ACCOUNT param (default kamutan-api@)', async () => {
    const mod = await import('../../src/function');
    for (const fn of [mod.api, mod.apiJobs, mod.reprocessDependents]) {
      const ep = (fn as unknown as { __endpoint: { serviceAccountEmail?: unknown } }).__endpoint;
      // A param expression (resolved by the Firebase CLI at deploy), never unset → never the default compute SA.
      expect(ep.serviceAccountEmail).toBe(mod.API_SERVICE_ACCOUNT);
    }
    expect(mod.API_SERVICE_ACCOUNT.name).toBe('API_SERVICE_ACCOUNT');
    expect((mod.API_SERVICE_ACCOUNT as unknown as { options: { default: string } }).options.default).toBe('kamutan-api@');
  });
});
