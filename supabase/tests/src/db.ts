import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { postgis } from '@electric-sql/pglite-postgis';

const here = dirname(fileURLToPath(import.meta.url));
export const SUPABASE_DIR = join(here, '..', '..');
export const MIGRATIONS_DIR = join(SUPABASE_DIR, 'migrations');
const STUB_SQL = join(here, '..', 'bootstrap', 'supabase_stub.sql');
export const RLS_GUARD_SQL = join(here, '..', 'sql', 'rls_guard.sql');

export type Q = PGlite | Transaction;

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{14}_.+\.sql$/.test(f))
    .sort();
}

/** Brand-new in-memory Postgres (PGlite + PostGIS) with the Supabase stub and all migrations applied. */
export async function buildFreshDb(): Promise<PGlite> {
  const db = await PGlite.create({ extensions: { postgis, pgcrypto } });
  await db.exec(readFileSync(STUB_SQL, 'utf8'));
  for (const f of migrationFiles()) {
    try {
      await db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
    } catch (e) {
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    }
  }
  return db;
}

/**
 * Migrated test database. Starts from the snapshot made by global-setup when
 * available (same content, much faster), otherwise builds from scratch.
 */
export async function createTestDb(opts: { seed?: boolean; fresh?: boolean } = {}): Promise<PGlite> {
  const snap = process.env.KAMUTAN_DB_SNAPSHOT;
  const db = snap && !opts.fresh && existsSync(snap)
    ? await PGlite.create({ loadDataDir: new Blob([readFileSync(snap)]), extensions: { postgis, pgcrypto } })
    : await buildFreshDb();
  if (opts.seed) {
    await db.exec(readFileSync(join(SUPABASE_DIR, 'seed.sql'), 'utf8'));
  }
  return db;
}

/**
 * Run `fn` as an authenticated end user (role `authenticated`, JWT sub = userId),
 * exactly like PostgREST / the NestJS API do. The transaction is committed when
 * `fn` resolves and rolled back when it throws.
 */
export async function asUser<T>(db: PGlite, userId: string | null, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId ?? '']);
    await tx.query(
      `select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify(userId ? { sub: userId, role: 'authenticated' } : { role: 'anon' })],
    );
    await tx.exec(userId ? 'set local role authenticated' : 'set local role anon');
    return fn(tx);
  });
}

/** Run `fn` as the pipeline worker role, scoped to `orgId` (the job's org). */
export async function asWorker<T>(db: PGlite, orgId: string | null, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('kamutan.org_id', $1, true)`, [orgId ?? '']);
    await tx.exec('set local role kamutan_worker');
    return fn(tx);
  });
}

/** Rows visible for a query. */
export async function rows<T = Record<string, unknown>>(q: Q, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await q.query<T>(sql, params)).rows;
}

/** Number of rows affected by a DML statement. */
export async function affected(q: Q, sql: string, params: unknown[] = []): Promise<number> {
  return (await q.query(sql, params)).affectedRows ?? 0;
}

/** Assert that the async op fails; returns the error message. */
export async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected operation to fail, but it succeeded');
}
