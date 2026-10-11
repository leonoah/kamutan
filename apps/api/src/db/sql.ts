/** Minimal SQL executor shared by node-postgres and PGlite (tests). */
export interface SqlExecutor {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * A database that can run a callback inside one transaction.
 * Implementations: PgPoolDatabase (prod), PGlite adapter (tests).
 */
export interface SqlDatabase {
  transaction<T>(fn: (q: SqlExecutor) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

/** Postgres error with SQLSTATE code (node-postgres and PGlite both expose `code`). */
export function pgErrorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return undefined;
}
