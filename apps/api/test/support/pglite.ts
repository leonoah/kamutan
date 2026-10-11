import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { postgis } from '@electric-sql/pglite-postgis';
import type { SqlDatabase, SqlExecutor } from '../../src/db/sql';

/** Repo paths (read-only): migrations are owned by the DB agent. */
export const SUPABASE_DIR = resolve(__dirname, '../../../../supabase');
const MIGRATIONS = join(SUPABASE_DIR, 'migrations');
const STUB = join(SUPABASE_DIR, 'tests/bootstrap/supabase_stub.sql');

export function migrationsAvailable(): boolean {
  return existsSync(STUB) && existsSync(MIGRATIONS) && readdirSync(MIGRATIONS).some((f) => f.endsWith('.sql'));
}

/** Fresh PGlite with the Supabase stub + all migrations applied. */
export async function createMigratedPglite(): Promise<PGlite> {
  const db = await PGlite.create({ extensions: { postgis, pgcrypto } });
  await db.exec(readFileSync(STUB, 'utf8'));
  for (const f of readdirSync(MIGRATIONS).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) {
    try {
      await db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
    } catch (e) {
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    }
  }
  return db;
}

/** Adapts PGlite to the SqlDatabase port used by PgRepository. */
export class PgliteDatabase implements SqlDatabase {
  constructor(private readonly db: PGlite) {}

  transaction<T>(fn: (q: SqlExecutor) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) =>
      fn({ query: async <R>(text: string, params?: unknown[]) => ({ rows: (await tx.query<R>(text, params)).rows }) }),
    );
  }

  async ping(): Promise<void> {
    await this.db.query('select 1');
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
