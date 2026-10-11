import { describe, expect, it } from 'vitest';
import { buildOpenApi } from '../../src/bootstrap';
import { loadConfig } from '../../src/config/config';
import { createTestApp } from '../support/app';
import { testConfig } from '../support/helpers';

const base = {
  SUPABASE_JWT_SECRET: 'x'.repeat(32),
  UPLOAD_TOKEN_SECRET: 'y'.repeat(32),
};

describe('config', () => {
  it('development defaults run without Postgres/Redis only when told so', () => {
    expect(() => loadConfig({ ...base, DATA_DRIVER: 'memory' })).not.toThrow();
    expect(() => loadConfig({ ...base })).toThrow(/DATABASE_URL/);
  });

  it('refuses insecure production settings and never echoes secret values', () => {
    let msg = '';
    try {
      loadConfig({ ...base, NODE_ENV: 'production', DATA_DRIVER: 'memory', CORS_ORIGINS: '*' });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/DATA_DRIVER/);
    expect(msg).toMatch(/QUEUE_DRIVER/);
    expect(msg).toMatch(/STORAGE_DRIVER/);
    expect(msg).toMatch(/CORS_ORIGINS/);
    expect(msg).not.toContain('x'.repeat(32));
  });

  it('accepts a complete production config', () => {
    const cfg = loadConfig({
      NODE_ENV: 'production',
      SUPABASE_URL: 'https://proj.supabase.co',
      JWT_USE_JWKS: 'true',
      DATABASE_URL: 'postgres://u:p@db:5432/postgres',
      DATABASE_SSL: 'require',
      QUEUE_DRIVER: 'bullmq',
      REDIS_URL: 'rediss://default:p@redis:6380',
      STORAGE_DRIVER: 'supabase',
      SUPABASE_SERVICE_ROLE_KEY: 'k',
      UPLOAD_TOKEN_SECRET: 'y'.repeat(32),
      CORS_ORIGINS: 'https://app.kamutan.co.il, https://staging.kamutan.co.il',
    });
    expect(cfg.CORS_ORIGINS).toEqual(['https://app.kamutan.co.il', 'https://staging.kamutan.co.il']);
  });
});

describe('OpenAPI', () => {
  it('documents the Sprint 0 endpoints with Zod-derived schemas', async () => {
    const t = await createTestApp(testConfig());
    try {
      const doc = buildOpenApi(t.app);
      expect(Object.keys(doc.paths).sort()).toEqual(
        [
          '/v1/health',
          '/v1/health/ready',
          '/v1/me',
          '/v1/orgs',
          '/v1/orgs/{orgId}',
          '/v1/projects',
          '/v1/projects/{projectId}',
          '/v1/projects/{projectId}/sheet-sets',
          '/v1/projects/{projectId}/uploads',
        ].sort(),
      );
      const body = doc.paths['/v1/projects/{projectId}/uploads']?.post?.requestBody as {
        content: Record<string, { schema: { properties: Record<string, unknown> } }>;
      };
      expect(Object.keys(body.content['application/json']?.schema.properties ?? {})).toEqual(['filename', 'sizeBytes', 'sha256']);
    } finally {
      await t.app.close();
    }
  });
});
