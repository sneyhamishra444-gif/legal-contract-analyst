/**
 * The schema, embedded as a string rather than read from a .sql file.
 *
 * This is a deployment decision, not a style one. Reading `schema.sql` with `fs`
 * at request time works locally and then fails on Vercel, because the bundler
 * traces `import`s and statically analysable paths — not a path built at runtime
 * with `path.join(process.cwd(), ...)`. The file would simply be absent inside
 * the function, and the first database call after deploying would throw. A
 * string constant cannot go missing.
 *
 * Portable by construction, and `tests/storage.test.ts` enforces it:
 *   * TEXT and INTEGER columns only
 *   * application-generated TEXT ids, never AUTOINCREMENT or SERIAL
 *   * timestamps and binary payloads stored as TEXT (ISO-8601 and base64),
 *     because BLOB and BYTEA are not interchangeable
 *   * `?` placeholders throughout; the Postgres driver rewrites them to $1..$n
 *   * no casts, no engine-specific functions
 */
export const SCHEMA_SQL = `
create table if not exists documents (
  id text primary key,
  title text not null,
  kind text not null,
  byte_size integer not null,
  page_count integer not null,
  char_count integer not null,
  clause_count integer not null,
  content_hash text not null,
  file_base64 text not null,
  text text not null,
  pages_json text not null,
  warnings_json text not null,
  created_at text not null
);

create index if not exists idx_documents_created on documents (created_at);
create index if not exists idx_documents_hash on documents (content_hash);

create table if not exists conversations (
  id text primary key,
  title text not null,
  document_ids_json text not null,
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_conversations_updated on conversations (updated_at);

create table if not exists messages (
  id text primary key,
  conversation_id text not null,
  role text not null,
  content text not null,
  status text not null,
  meta_json text not null,
  created_at text not null
);

create index if not exists idx_messages_conversation on messages (conversation_id, created_at);

create table if not exists comparisons (
  id text primary key,
  left_document_id text not null,
  right_document_id text not null,
  created_at text not null,
  payload_json text not null
);

create index if not exists idx_comparisons_pair on comparisons (left_document_id, right_document_id);
`;

/** Tokens that would break one of the two engines. Checked by the test suite. */
export const NON_PORTABLE_SQL_TOKENS = [
  "autoincrement",
  "serial",
  "bigserial",
  "bytea",
  "blob",
  "on conflict",
  "returning",
  "::",
  "varchar",
  "timestamptz",
  "boolean",
  "jsonb",
  "$1",
];
