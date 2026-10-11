import { Pool, type PoolConfig } from 'pg';
import type { SqlDatabase, SqlExecutor } from './sql';

/** node-postgres pool. Each `transaction` checks out one client: BEGIN … COMMIT/ROLLBACK. */
export class PgPoolDatabase implements SqlDatabase {
  private readonly pool: Pool;

  constructor(config: PoolConfig) {
    this.pool = new Pool({
      statement_timeout: 15_000,
      idle_in_transaction_session_timeout: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: 'kamutan-api',
      ...config,
    });
    // A broken idle client must not crash the process.
    this.pool.on('error', () => undefined);
  }

  async transaction<T>(fn: (q: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await fn({
        query: async <R>(text: string, params?: unknown[]) => {
          const r = await client.query(text, params as unknown[] | undefined);
          return { rows: r.rows as R[] };
        },
      });
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query('select 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
