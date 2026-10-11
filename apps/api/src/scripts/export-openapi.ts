/**
 * Writes the OpenAPI document to apps/api/openapi.json without connecting to
 * Postgres/Redis (memory drivers, dummy secrets). Run after `pnpm build`:
 *   node dist/scripts/export-openapi.js [outFile]
 */
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildOpenApi, createApp } from '../bootstrap';
import { loadConfig } from '../config/config';

async function main(): Promise<void> {
  const cfg = loadConfig({
    NODE_ENV: 'development',
    DATA_DRIVER: 'memory',
    QUEUE_DRIVER: 'memory',
    STORAGE_DRIVER: 'supabase',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'unused',
    SUPABASE_JWT_SECRET: 'x'.repeat(32),
    UPLOAD_TOKEN_SECRET: 'x'.repeat(32),
    LOG_LEVEL: 'silent',
    SWAGGER_ENABLED: 'false',
  });
  const app = await createApp(cfg);
  await app.init();
  const out = resolve(process.argv[2] ?? 'openapi.json');
  writeFileSync(out, JSON.stringify(buildOpenApi(app), null, 2) + '\n');
  await app.close();
  console.log(`wrote ${out}`);
}

void main();
