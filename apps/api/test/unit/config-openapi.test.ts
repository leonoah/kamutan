import { describe, expect, it } from 'vitest';
import { buildOpenApi } from '../../src/bootstrap';
import { loadConfig } from '../../src/config/config';
import { createTestApp } from '../support/app';
import { testConfig } from '../support/helpers';

const secret = { UPLOAD_TOKEN_SECRET: 'y'.repeat(32) };

describe('config', () => {
  it('defaults to Firebase project kamutan-fba67, Firestore, Storage and Pub/Sub', () => {
    const cfg = loadConfig({ ...secret });
    expect(cfg).toMatchObject({
      GOOGLE_CLOUD_PROJECT: 'kamutan-fba67',
      FIREBASE_STORAGE_BUCKET: 'kamutan-fba67.firebasestorage.app',
      DATA_DRIVER: 'firestore',
      STORAGE_DRIVER: 'firebase',
      QUEUE_DRIVER: 'pubsub',
      INGEST_TOPIC: 'ingest',
      CORS_ORIGINS: [],
    });
  });

  it('requires the upload secret and never echoes values', () => {
    expect(() => loadConfig({})).toThrow(/UPLOAD_TOKEN_SECRET/);
    let msg = '';
    try {
      loadConfig({ UPLOAD_TOKEN_SECRET: 'short-secret-value' });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toContain('short-secret-value');
  });

  it('refuses memory drivers and wildcard CORS in production', () => {
    let msg = '';
    try {
      loadConfig({ ...secret, NODE_ENV: 'production', DATA_DRIVER: 'memory', STORAGE_DRIVER: 'memory', QUEUE_DRIVER: 'memory', CORS_ORIGINS: '*' });
    } catch (e) {
      msg = (e as Error).message;
    }
    for (const k of ['DATA_DRIVER', 'STORAGE_DRIVER', 'QUEUE_DRIVER', 'CORS_ORIGINS']) expect(msg).toContain(k);
    expect(() => loadConfig({ ...secret, NODE_ENV: 'production' })).not.toThrow();
  });
});

describe('OpenAPI', () => {
  it('documents the Sprint 0 + 1 endpoints under /api/v1', async () => {
    const t = await createTestApp(testConfig());
    try {
      const doc = buildOpenApi(t.app);
      expect(Object.keys(doc.paths).sort()).toEqual(
        [
          '/api/v1/health',
          '/api/v1/health/ready',
          '/api/v1/jobs/{jobId}',
          '/api/v1/me',
          '/api/v1/orgs',
          '/api/v1/orgs/{orgId}',
          '/api/v1/projects',
          '/api/v1/projects/{projectId}',
          '/api/v1/projects/{projectId}/sheet-sets',
          '/api/v1/projects/{projectId}/sheets',
          '/api/v1/projects/{projectId}/sheets/{sheetId}/confirm',
          '/api/v1/projects/{projectId}/sheets/{sheetId}/regions',
          '/api/v1/projects/{projectId}/sheets/{sheetId}/reprocess',
          '/api/v1/projects/{projectId}/sheets/{sheetId}/versions/{versionId}',
          '/api/v1/projects/{projectId}/sheets/{sheetId}/versions/{versionId}/tiles-manifest',
          '/api/v1/projects/{projectId}/uploads',
        ].sort(),
      );
      const tiles = doc.paths['/api/v1/projects/{projectId}/sheets/{sheetId}/versions/{versionId}/tiles-manifest']?.get;
      const names = (tiles?.parameters ?? []).map((p) => ('name' in p ? p.name : ''));
      expect(names).toEqual(expect.arrayContaining(['z', 'x0', 'x1', 'y0', 'y1']));
    } finally {
      await t.app.close();
    }
  });
});
