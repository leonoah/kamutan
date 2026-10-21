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
  it('documents the Sprint 0 + 1 + 2 + 3 + 4 + 5 endpoints under /api/v1', async () => {
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
          '/api/v1/projects/{projectId}/sheets/{sheetId}/versions/{versionId}/overlay',
          '/api/v1/projects/{projectId}/legend-entries',
          '/api/v1/projects/{projectId}/legend-entries/{entryId}',
          '/api/v1/projects/{projectId}/unknown-clusters/{clusterId}/resolve',
          // Sprint 3
          '/api/v1/library/items',
          '/api/v1/library/items/{itemId}',
          '/api/v1/library/imports',
          '/api/v1/library/imports/{importId}',
          '/api/v1/library/imports/{importId}/finalize',
          '/api/v1/boq-templates',
          '/api/v1/boq-templates/{templateId}',
          '/api/v1/boq-rules',
          '/api/v1/boq-rules/{ruleId}',
          '/api/v1/projects/{projectId}/boq',
          '/api/v1/projects/{projectId}/boq/build',
          '/api/v1/projects/{projectId}/boq/evidence',
          '/api/v1/projects/{projectId}/boq/export',
          '/api/v1/projects/{projectId}/boq/lines/{lineId}',
          '/api/v1/projects/{projectId}/boq/lines/{lineId}/evidence',
          // Sprint 4
          '/api/v1/projects/{projectId}/corrections',
          '/api/v1/projects/{projectId}/corrections/batch',
          '/api/v1/projects/{projectId}/corrections/{correctionId}/revert',
          '/api/v1/projects/{projectId}/correction-batches/{batchId}/revert',
          '/api/v1/projects/{projectId}/review-queue',
          '/api/v1/projects/{projectId}/rooms/{sheetId}/{roomId}/settings',
          '/api/v1/projects/{projectId}/similar-searches',
          '/api/v1/projects/{projectId}/similar-searches/{searchId}',
          // Sprint 5
          '/api/v1/orgs/{orgId}/audit',
          '/api/v1/orgs/{orgId}/audit/verify',
          '/api/v1/orgs/{orgId}/settings',
          '/api/v1/orgs/{orgId}/offboarding',
          '/api/v1/orgs/{orgId}/offboarding/export',
          '/api/v1/orgs/{orgId}/offboarding/export/{exportId}',
          '/api/v1/projects/{projectId}/boq/lines/{lineId}/history',
          '/api/v1/projects/{projectId}/boq/export/marked-pdf',
          '/api/v1/projects/{projectId}/exports/{exportId}',
          '/api/v1/projects/{projectId}/share-links',
          '/api/v1/projects/{projectId}/share-links/{linkId}',
          '/api/v1/public/share/{token}/meta',
          '/api/v1/public/share/{token}/boq',
          '/api/v1/public/share/{token}/pdf',
          '/api/v1/public/share/{token}/sheets/{sheetId}/overlay',
          '/api/v1/public/share/{token}/sheets/{sheetId}/tiles/{z}/{x}/{y}',
        ].sort(),
      );
      const tiles = doc.paths['/api/v1/projects/{projectId}/sheets/{sheetId}/versions/{versionId}/tiles-manifest']?.get;
      const names = (tiles?.parameters ?? []).map((p) => ('name' in p ? p.name : ''));
      expect(names).toEqual(expect.arrayContaining(['z', 'x0', 'x1', 'y0', 'y1']));
      const legend = doc.paths['/api/v1/projects/{projectId}/legend-entries']?.get;
      expect((legend?.parameters ?? []).map((p) => ('name' in p ? p.name : ''))).toEqual(expect.arrayContaining(['status', 'sheetId', 'cursor', 'limit']));
      expect(doc.paths['/api/v1/projects/{projectId}/legend-entries/{entryId}']?.patch).toBeDefined();
      const boq = doc.paths['/api/v1/projects/{projectId}/boq']?.get;
      expect((boq?.parameters ?? []).map((p) => ('name' in p ? p.name : ''))).toEqual(expect.arrayContaining(['cursor', 'limit', 'chapter', 'level', 'status']));
      expect(doc.paths['/api/v1/projects/{projectId}/boq/export']?.post).toBeDefined();
      expect(doc.paths['/api/v1/boq-rules/{ruleId}']?.patch).toBeDefined();
      const queue = doc.paths['/api/v1/projects/{projectId}/review-queue']?.get;
      expect((queue?.parameters ?? []).map((p) => ('name' in p ? p.name : ''))).toEqual(expect.arrayContaining(['kind', 'sheetId', 'floor', 'level', 'cursor', 'limit']));
      expect(doc.paths['/api/v1/projects/{projectId}/corrections']?.post).toBeDefined();
      expect(doc.paths['/api/v1/projects/{projectId}/corrections']?.get).toBeDefined();
      expect(doc.paths['/api/v1/projects/{projectId}/rooms/{sheetId}/{roomId}/settings']?.put).toBeDefined();
      // Sprint 5
      const audit = doc.paths['/api/v1/orgs/{orgId}/audit']?.get;
      expect((audit?.parameters ?? []).map((p) => ('name' in p ? p.name : ''))).toEqual(expect.arrayContaining(['cursor', 'limit', 'entity', 'action', 'entityId']));
      expect(doc.paths['/api/v1/orgs/{orgId}/settings']?.patch).toBeDefined();
      expect(doc.paths['/api/v1/projects/{projectId}/share-links/{linkId}']?.delete).toBeDefined();
      expect(doc.paths['/api/v1/projects/{projectId}/share-links']?.post).toBeDefined();
      expect(doc.paths['/api/v1/public/share/{token}/meta']?.post).toBeUndefined();
    } finally {
      await t.app.close();
    }
  });
});
