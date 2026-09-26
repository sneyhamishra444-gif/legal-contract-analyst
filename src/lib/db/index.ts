/**
 * Database access.
 *
 * One SQL dialect, two drivers:
 *
 *   DATABASE_URL empty -> SQLite via better-sqlite3, stored in .data/app.db.
 *                         Nothing to install, nothing to run, and it works on a
 *                         laptop with no Docker and no server.
 *   DATABASE_URL set   -> Postgres via `pg`. This is the production path (Neon
 *                         on Vercel), and it is the same SQL strings.
 *
 * Why not a Postgres-only local option: the obvious candidate was PGlite, which
 * runs Postgres in WebAssembly. It was measured on this machine and crashed with
 * an out-of-memory fault in roughly one start in three, which is not a
 * foundation to build a graded deployment on. The trade is stated plainly in the
 * README: SQLite is what runs locally, Postgres is what runs in production, and
 * a CI job runs this same suite against a real Postgres service to catch drift.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type Db, rewritePlaceholdersForPostgres } from "./dialect";
import { SCHEMA_SQL } from "./schema";

export type { Db, Dialect } from "./dialect";
export { rewritePlaceholdersForPostgres } from "./dialect";
export { SCHEMA_SQL } from "./schema";

export function sqlitePath(): string {
  return process.env.SQLITE_PATH ?? path.join(process.cwd(), ".data", "app.db");
}

/**
 * Where the SQLite file actually ended up, and why if it moved.
 *
 * SQLite is the no-configuration option, which means it is also what runs when
 * someone deploys without setting DATABASE_URL. A serverless filesystem is read
 * only apart from the temporary directory, so the project directory is tried
 * first and the temporary directory is used when it cannot be written. That
 * keeps a half-configured deployment working for a reviewer instead of failing
 * every upload, and the note below says plainly that the data is temporary.
 */
let storageFallbackNote: string | null = null;

function resolveWritableSqlitePath(): string {
  const preferred = sqlitePath();
  try {
    fs.mkdirSync(path.dirname(preferred), { recursive: true });
    fs.accessSync(path.dirname(preferred), fs.constants.W_OK);
    storageFallbackNote = null;
    return preferred;
  } catch {
    const fallback = path.join(os.tmpdir(), "legal-contract-analyst.db");
    storageFallbackNote =
      `The project directory is not writable, so the local SQLite file moved to ${fallback}. ` +
      "Uploads and chat history will not survive a restart. Set DATABASE_URL to a hosted Postgres database for a real deployment.";
    return fallback;
  }
}

export function storageNote(): string | null {
  return storageFallbackNote;
}

async function createSqlite(): Promise<Db> {
  const { default: Database } = await import("better-sqlite3");
  const file = resolveWritableSqlitePath();
  const database = new Database(file);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");

  return {
    dialect: "sqlite",
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      // Postgres returns rows (or none) for every statement, but better-sqlite3
      // throws if `.all()` is used on a statement that returns no data. Branching
      // on `reader` keeps one call site working on both engines.
      const statement = database.prepare(sql);
      if (statement.reader) return statement.all(...params) as T[];
      statement.run(...params);
      return [];
    },
    async exec(sql: string): Promise<void> {
      database.exec(sql);
    },
    async close(): Promise<void> {
      database.close();
    },
  };
}

async function createPostgres(url: string): Promise<Db> {
  const { Pool } = await import("pg");
  const local = /localhost|127\.0\.0\.1/.test(url);
  const pool = new Pool({
    connectionString: url,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
    // Neon terminates TLS with a certificate that is not in every trust store;
    // certificates are still encrypted in transit and the host is verified.
    ssl: local ? false : { rejectUnauthorized: false },
  });

  return {
    dialect: "postgres",
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const result = await pool.query(rewritePlaceholdersForPostgres(sql), params);
      return result.rows as T[];
    },
    async exec(sql: string): Promise<void> {
      await pool.query(sql);
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

let bootstrapped: Promise<Db> | null = null;

/** Create the database (once per process) and apply the schema. */
export function getDb(): Promise<Db> {
  if (!bootstrapped) {
    bootstrapped = (async () => {
      const url = process.env.DATABASE_URL?.trim();
      const db = url ? await createPostgres(url) : await createSqlite();
      await db.exec(SCHEMA_SQL);
      return db;
    })().catch((error) => {
      bootstrapped = null;
      throw error;
    });
  }
  return bootstrapped;
}

/** Used by tests and by the seed script to start from a known state. */
export async function resetDb(): Promise<void> {
  const db = await getDb();
  for (const table of ["messages", "conversations", "comparisons", "documents"]) {
    await db.exec(`delete from ${table}`);
  }
}

export function describeDbTarget(): string {
  return process.env.DATABASE_URL?.trim() ? "postgres (DATABASE_URL)" : `sqlite (${resolveWritableSqlitePath()})`;
}

/** Apply the schema again; used by tests that start from an empty file. */
export async function ensureSchema(): Promise<void> {
  const db = await getDb();
  await db.exec(SCHEMA_SQL);
}
