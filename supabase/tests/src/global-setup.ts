import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFreshDb } from './db';

/**
 * Build ONE database (PostGIS + stub + all migrations) and snapshot its data dir,
 * so test files can start from it instead of re-running PostGIS install each time.
 * `migrations.test.ts` still applies every migration to a brand-new database.
 */
export default async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'kamutan-db-'));
  const file = join(dir, 'snapshot.tar');
  const db = await buildFreshDb();
  const dump = await db.dumpDataDir('none');
  writeFileSync(file, Buffer.from(await dump.arrayBuffer()));
  await db.close();
  process.env.KAMUTAN_DB_SNAPSHOT = file;
  return () => rmSync(dir, { recursive: true, force: true });
}
