/**
 * Data access. Plain SQL through the small `Db` seam, so the same statements run
 * on SQLite locally and Postgres in production.
 */

import { createHash } from "node:crypto";

import { type Db, getDb } from "@/lib/db";
import type {
  ChatMessage,
  ChatRole,
  ChatMessageStatus,
  Conversation,
  DocumentKind,
  DocumentRecord,
  MessageMeta,
  StoredDocument,
} from "@/lib/types";
import { EMPTY_MESSAGE_META } from "@/lib/types";

type DocumentRow = {
  id: string;
  title: string;
  kind: string;
  byte_size: number;
  page_count: number;
  char_count: number;
  clause_count: number;
  content_hash: string;
  file_base64: string;
  text: string;
  pages_json: string;
  warnings_json: string;
  created_at: string;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  status: string;
  meta_json: string;
  created_at: string;
};

type ConversationRow = {
  id: string;
  title: string;
  document_ids_json: string;
  created_at: string;
  updated_at: string;
};

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toStoredDocument(row: DocumentRow): StoredDocument {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind === "docx" ? "docx" : "pdf",
    byteSize: row.byte_size,
    pageCount: row.page_count,
    charCount: row.char_count,
    clauseCount: row.clause_count,
    createdAt: row.created_at,
    warnings: safeJson<string[]>(row.warnings_json, []),
  };
}

function toDocumentRecord(row: DocumentRow): DocumentRecord {
  return {
    ...toStoredDocument(row),
    contentHash: row.content_hash,
    fileBase64: row.file_base64,
    text: row.text,
    pages: safeJson<DocumentRecord["pages"]>(row.pages_json, []),
  };
}

export type InsertDocumentInput = {
  title: string;
  kind: DocumentKind;
  bytes: Uint8Array;
  text: string;
  pages: DocumentRecord["pages"];
  warnings: string[];
  clauseCount: number;
};

/**
 * Store a document, or hand back the existing one when the same bytes are
 * uploaded twice. Re-uploading the same contract is common and silently
 * creating a second copy would split its chat history in two.
 */
export async function insertDocument(
  input: InsertDocumentInput,
): Promise<{ document: StoredDocument; duplicate: boolean }> {
  const db: Db = await getDb();
  const contentHash = hashBytes(input.bytes);

  const existing = await db.query<DocumentRow>(`select * from documents where content_hash = ?`, [contentHash]);
  const match = existing[0];
  if (match) return { document: toStoredDocument(match), duplicate: true };

  const id = newId("doc");
  const createdAt = nowIso();
  await db.query(
    `insert into documents
       (id, title, kind, byte_size, page_count, char_count, clause_count, content_hash, file_base64, text, pages_json, warnings_json, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.title,
      input.kind,
      input.bytes.length,
      input.pages.length,
      input.text.length,
      input.clauseCount,
      contentHash,
      Buffer.from(input.bytes).toString("base64"),
      input.text,
      JSON.stringify(input.pages),
      JSON.stringify(input.warnings),
      createdAt,
    ],
  );

  return {
    document: {
      id,
      title: input.title,
      kind: input.kind,
      byteSize: input.bytes.length,
      pageCount: input.pages.length,
      charCount: input.text.length,
      clauseCount: input.clauseCount,
      createdAt,
      warnings: input.warnings,
    },
    duplicate: false,
  };
}

export async function listDocuments(): Promise<StoredDocument[]> {
  const db = await getDb();
  const rows = await db.query<DocumentRow>(`select * from documents order by created_at desc`);
  return rows.map(toStoredDocument);
}

export async function getDocumentRecord(id: string): Promise<DocumentRecord | null> {
  const db = await getDb();
  const rows = await db.query<DocumentRow>(`select * from documents where id = ?`, [id]);
  const row = rows[0];
  return row ? toDocumentRecord(row) : null;
}

export async function getManyDocumentRecords(ids: string[]): Promise<DocumentRecord[]> {
  if (ids.length === 0) return [];
  const db = await getDb();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = await db.query<DocumentRow>(
    `select * from documents where id in (${placeholders})`,
    ids,
  );
  return rows.map(toDocumentRecord);
}

export async function deleteDocument(id: string): Promise<boolean> {
  const db = await getDb();
  const existing = await getDocumentRecord(id);
  if (!existing) return false;
  await db.query(`delete from documents where id = ?`, [id]);
  await db.query(`delete from comparisons where left_document_id = ? or right_document_id = ?`, [id, id]);

  // Message history belongs to the documents it was asked about; drop the
  // conversations that referenced this document so nothing dangles.
  const conversations = await db.query<ConversationRow>(`select * from conversations`);
  for (const row of conversations) {
    const ids = safeJson<string[]>(row.document_ids_json, []);
    if (!ids.includes(id)) continue;
    const remaining = ids.filter((value) => value !== id);
    if (remaining.length === 0) {
      await db.query(`delete from messages where conversation_id = ?`, [row.id]);
      await db.query(`delete from conversations where id = ?`, [row.id]);
    } else {
      await db.query(`update conversations set document_ids_json = ? where id = ?`, [
        JSON.stringify(remaining),
        row.id,
      ]);
    }
  }
  return true;
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    documentIds: safeJson<string[]>(row.document_ids_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createConversation(input: {
  title: string;
  documentIds: string[];
}): Promise<Conversation> {
  const db = await getDb();
  const id = newId("conv");
  const timestamp = nowIso();
  await db.query(
    `insert into conversations (id, title, document_ids_json, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [id, input.title, JSON.stringify(input.documentIds), timestamp, timestamp],
  );
  return { id, title: input.title, documentIds: input.documentIds, createdAt: timestamp, updatedAt: timestamp };
}

export async function getConversation(id: string): Promise<Conversation | null> {
  const db = await getDb();
  const rows = await db.query<ConversationRow>(`select * from conversations where id = ?`, [id]);
  const row = rows[0];
  return row ? toConversation(row) : null;
}

export async function listConversations(documentId?: string): Promise<Conversation[]> {
  const db = await getDb();
  const rows = await db.query<ConversationRow>(`select * from conversations order by updated_at desc`);
  const all = rows.map(toConversation);
  return documentId ? all.filter((conversation) => conversation.documentIds.includes(documentId)) : all;
}

export async function touchConversation(id: string): Promise<void> {
  const db = await getDb();
  await db.query(`update conversations set updated_at = ? where id = ?`, [nowIso(), id]);
}

export async function renameConversation(id: string, title: string): Promise<void> {
  const db = await getDb();
  await db.query(`update conversations set title = ? where id = ?`, [title, id]);
}

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    status: (row.status as ChatMessageStatus) ?? "complete",
    createdAt: row.created_at,
    meta: safeJson<MessageMeta>(row.meta_json, EMPTY_MESSAGE_META),
  };
}

export async function insertMessage(input: {
  conversationId: string;
  role: ChatRole;
  content: string;
  status: ChatMessageStatus;
  meta?: MessageMeta;
}): Promise<ChatMessage> {
  const db = await getDb();
  const id = newId("msg");
  const createdAt = nowIso();
  const meta = input.meta ?? EMPTY_MESSAGE_META;
  await db.query(
    `insert into messages (id, conversation_id, role, content, status, meta_json, created_at) values (?, ?, ?, ?, ?, ?, ?)`,
    [id, input.conversationId, input.role, input.content, input.status, JSON.stringify(meta), createdAt],
  );
  await touchConversation(input.conversationId);
  return {
    id,
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    status: input.status,
    createdAt,
    meta,
  };
}

/** Used when a stream is stopped part-way: the partial answer is kept, not discarded. */
export async function updateMessage(
  id: string,
  patch: { content?: string; status?: ChatMessageStatus; meta?: MessageMeta },
): Promise<void> {
  const db = await getDb();
  const rows = await db.query<MessageRow>(`select * from messages where id = ?`, [id]);
  const row = rows[0];
  if (!row) return;
  const current = toMessage(row);
  await db.query(`update messages set content = ?, status = ?, meta_json = ? where id = ?`, [
    patch.content ?? current.content,
    patch.status ?? current.status,
    JSON.stringify(patch.meta ?? current.meta),
    id,
  ]);
}

export async function listMessages(conversationId: string): Promise<ChatMessage[]> {
  const db = await getDb();
  const rows = await db.query<MessageRow>(
    `select * from messages where conversation_id = ? order by created_at asc`,
    [conversationId],
  );
  return rows.map(toMessage);
}

export async function deleteConversationMessages(conversationId: string): Promise<void> {
  const db = await getDb();
  await db.query(`delete from messages where conversation_id = ?`, [conversationId]);
}

export async function saveComparison(input: {
  leftDocumentId: string;
  rightDocumentId: string;
  payload: unknown;
}): Promise<string> {
  const db = await getDb();
  const id = newId("cmp");
  await db.query(
    `insert into comparisons (id, left_document_id, right_document_id, created_at, payload_json) values (?, ?, ?, ?, ?)`,
    [id, input.leftDocumentId, input.rightDocumentId, nowIso(), JSON.stringify(input.payload)],
  );
  return id;
}

export async function findComparison<T>(leftId: string, rightId: string): Promise<T | null> {
  const db = await getDb();
  const rows = await db.query<{ payload_json: string }>(
    `select payload_json from comparisons where left_document_id = ? and right_document_id = ? order by created_at desc`,
    [leftId, rightId],
  );
  const row = rows[0];
  return row ? safeJson<T | null>(row.payload_json, null) : null;
}
