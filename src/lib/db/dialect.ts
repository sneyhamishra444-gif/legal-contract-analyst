/**
 * The tiny seam between one set of SQL strings and two database engines.
 *
 * SQLite and Postgres disagree about how a bound parameter is written: SQLite
 * accepts `?`, Postgres wants `$1`. Everything else in this project's SQL is
 * already portable, so that one difference is handled here rather than by
 * maintaining two copies of every query — two copies is how a query gets fixed
 * locally and stays broken in production.
 */

export type Dialect = "sqlite" | "postgres";

export type Db = {
  dialect: Dialect;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
};

/**
 * `?` -> `$1`, `$2`, ... in order of appearance.
 *
 * Deliberately naive about string literals: no query in this project contains a
 * literal `?`, and `tests/storage.test.ts` asserts that, so the simple version
 * stays honest instead of growing a half-written SQL lexer.
 */
export function rewritePlaceholdersForPostgres(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
}

export function countPlaceholders(sql: string): number {
  return (sql.match(/\?/g) ?? []).length;
}
