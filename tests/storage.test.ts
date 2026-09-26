import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

// Point the store at a throwaway file before anything opens a database.
process.env.SQLITE_PATH = path.join(os.tmpdir(), `lca-storage-${Date.now()}.db`);
process.env.DATABASE_URL = "";

import { NON_PORTABLE_SQL_TOKENS, SCHEMA_SQL } from "@/lib/db/schema";
import { describeDbTarget, getDb, resetDb } from "@/lib/db";
import { countPlaceholders, rewritePlaceholdersForPostgres } from "@/lib/db/dialect";
import {
  createConversation,
  deleteConversationMessages,
  deleteDocument,
  findComparison,
  getConversation,
  getDocumentRecord,
  hashBytes,
  insertDocument,
  insertMessage,
  listConversations,
  listDocuments,
  listMessages,
  saveComparison,
  updateMessage,
} from "@/lib/storage/repository";
import { loadDocumentBundle } from "@/lib/storage/documents";

const bytes = new TextEncoder().encode("1.1 A contract with some words in it, long enough to be extracted properly.");

async function seedDocument(title = "Test agreement") {
  return insertDocument({
    title,
    kind: "docx",
    bytes,
    text: "1.1 A contract with some words in it, long enough to be extracted properly.\n\n2.1 Payment shall be made within thirty (30) days.",
    pages: [],
    warnings: [],
    clauseCount: 2,
  });
}

beforeAll(async () => {
  await resetDb();
});

describe("schema portability", () => {
  it("avoids SQL that works on one engine but not the other", () => {
    const lowered = SCHEMA_SQL.toLowerCase();
    for (const token of NON_PORTABLE_SQL_TOKENS) {
      expect(lowered, `schema must not use "${token}"`).not.toContain(token.toLowerCase());
    }
  });

  it("uses only text and integer columns, so both engines agree on types", () => {
    const columnTypes = [...SCHEMA_SQL.matchAll(/^\s+(\w+)\s+([a-z]+)/gm)].map((match) => match[2]);
    const allowed = new Set(["text", "integer"]);
    const suspicious = columnTypes.filter(
      (type) => type !== undefined && type !== "primary" && type !== "not" && type !== "if",
    );
    // Only statement keywords appear where a type would be; everything else is text/integer.
    for (const candidate of suspicious) {
      if (["references", "default"].includes(candidate ?? "")) continue;
      expect(allowed.has(candidate ?? "") || ["create", "table", "index", "on", "key"].includes(candidate ?? "")).toBe(
        true,
      );
    }
  });

  it("rewrites ? placeholders to Postgres numbering in order", () => {
    expect(rewritePlaceholdersForPostgres("insert into t (a, b) values (?, ?)")).toBe(
      "insert into t (a, b) values ($1, $2)",
    );
    expect(rewritePlaceholdersForPostgres("select * from t where a = ? and b = ? and c = ?")).toBe(
      "select * from t where a = $1 and b = $2 and c = $3",
    );
    expect(rewritePlaceholdersForPostgres("select 1")).toBe("select 1");
    expect(countPlaceholders("select * from t where a = ? and b = ?")).toBe(2);
  });

  it("writes every repository query with ? placeholders and no engine-specific SQL", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/lib/storage/repository.ts"), "utf8");
    const statements = [...source.matchAll(/`([^`]*?(?:select|insert|update|delete)[^`]*?)`/gis)].map(
      (match) => match[1] ?? "",
    );
    expect(statements.length).toBeGreaterThan(8);
    for (const statement of statements) {
      expect(statement).not.toMatch(/\$\d/);
      expect(statement.toLowerCase()).not.toContain("returning");
      expect(statement).not.toContain("::");
      expect(statement.toLowerCase()).not.toContain("ilike");
    }
  });
});

describe("documents", () => {
  it("stores a document and reads it back with its text and page map", async () => {
    await resetDb();
    const { document, duplicate } = await seedDocument();
    expect(duplicate).toBe(false);

    const list = await listDocuments();
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe("Test agreement");

    const record = await getDocumentRecord(document.id);
    expect(record?.text).toContain("Payment shall be made");
    expect(record?.kind).toBe("docx");
    expect(record?.fileBase64.length).toBeGreaterThan(0);
    expect(Buffer.from(record?.fileBase64 ?? "", "base64").length).toBe(bytes.length);
  });

  it("returns the existing document when the same bytes are uploaded twice", async () => {
    await resetDb();
    const first = await seedDocument();
    const second = await seedDocument("A different file name");
    expect(second.duplicate).toBe(true);
    expect(second.document.id).toBe(first.document.id);
    expect(await listDocuments()).toHaveLength(1);
  });

  it("deletes a document together with its chat history", async () => {
    await resetDb();
    const { document } = await seedDocument();
    const conversation = await createConversation({ title: "Q", documentIds: [document.id] });
    await insertMessage({ conversationId: conversation.id, role: "user", content: "hi", status: "complete" });

    expect(await deleteDocument(document.id)).toBe(true);
    expect(await listDocuments()).toHaveLength(0);
    expect(await getConversation(conversation.id)).toBeNull();
    expect(await listMessages(conversation.id)).toHaveLength(0);
    expect(await deleteDocument(document.id)).toBe(false);
  });

  it("hashes content deterministically", () => {
    expect(hashBytes(bytes)).toBe(hashBytes(bytes));
    expect(hashBytes(bytes)).not.toBe(hashBytes(new TextEncoder().encode("other")));
  });

  it("loads a searchable bundle with chunks and clauses", async () => {
    await resetDb();
    const { document } = await seedDocument();
    const bundle = await loadDocumentBundle(document.id);
    expect(bundle).not.toBeNull();
    expect(bundle?.chunks.length ?? 0).toBeGreaterThan(0);
    expect(bundle?.document.text).toContain("Payment shall be made");
    // Cached: a second load returns the same object identity.
    expect(await loadDocumentBundle(document.id)).toBe(bundle);
  });
});

describe("conversations and messages", () => {
  it("keeps per-document history in order and can be reopened", async () => {
    await resetDb();
    const { document } = await seedDocument();
    const conversation = await createConversation({ title: "Liability", documentIds: [document.id] });

    await insertMessage({ conversationId: conversation.id, role: "user", content: "What is the cap?", status: "complete" });
    const assistant = await insertMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: "The cap is 100,000.",
      status: "complete",
      meta: {
        quotes: [],
        steps: [],
        coverage: null,
        model: "test",
        provider: "offline",
        warnings: ["a warning"],
      },
    });

    const messages = await listMessages(conversation.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.meta.warnings).toEqual(["a warning"]);

    await updateMessage(assistant.id, { status: "stopped", content: "The cap is" });
    const updated = await listMessages(conversation.id);
    expect(updated[1]?.status).toBe("stopped");
    expect(updated[1]?.content).toBe("The cap is");
    expect(updated[1]?.meta.warnings).toEqual(["a warning"]);

    expect(await listConversations(document.id)).toHaveLength(1);
    expect(await listConversations("other-document")).toHaveLength(0);
  });

  it("clears a conversation's messages when asked", async () => {
    await resetDb();
    const { document } = await seedDocument();
    const conversation = await createConversation({ title: "Q", documentIds: [document.id] });
    await insertMessage({ conversationId: conversation.id, role: "user", content: "hi", status: "complete" });
    await deleteConversationMessages(conversation.id);
    expect(await listMessages(conversation.id)).toHaveLength(0);
  });

  it("keeps a partially generated answer rather than discarding it", async () => {
    await resetDb();
    const { document } = await seedDocument();
    const conversation = await createConversation({ title: "Q", documentIds: [document.id] });
    const message = await insertMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: "",
      status: "error",
    });
    await updateMessage(message.id, { content: "Half an answer", status: "stopped" });
    const [stored] = await listMessages(conversation.id);
    expect(stored?.status).toBe("stopped");
    expect(stored?.content).toBe("Half an answer");
  });
});

describe("comparisons", () => {
  it("stores and finds a comparison by document pair", async () => {
    await resetDb();
    const { document: left } = await seedDocument("v1");
    const { document: right } = await seedDocument("v2");
    await saveComparison({ leftDocumentId: left.id, rightDocumentId: right.id, payload: { changes: 3 } });
    const found = await findComparison<{ changes: number }>(left.id, right.id);
    expect(found?.changes).toBe(3);
    expect(await findComparison(left.id, "nope")).toBeNull();
  });
});

describe("database target", () => {
  it("reports which engine is in use, so a deployment can be checked from /api/health", async () => {
    await getDb();
    expect(describeDbTarget()).toMatch(/sqlite/);
    process.env.DATABASE_URL = "postgresql://example";
    expect(describeDbTarget()).toMatch(/postgres/);
    process.env.DATABASE_URL = "";
  });
});
