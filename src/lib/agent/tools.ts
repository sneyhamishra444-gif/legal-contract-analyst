/**
 * The tools the agent may call.
 *
 * The point of this file — and of the Part C option it implements — is that the
 * model never receives the document. It receives the *results of its own
 * queries*, and has to decide what to look up. Three consequences follow, and
 * all three are handled here rather than hoped for:
 *
 *   1. Every tool takes untrusted, model-authored arguments, so each validates
 *      and returns a message written for the model ("number must look like
 *      11 or 11.2") instead of throwing.
 *   2. A tool that finds nothing says so plainly, which is what stops the model
 *      from answering a question the document does not cover.
 *   3. Results carry how much of the document was searched, so "I could not
 *      find it" can never be confused with "it is not there".
 */

import { searchChunks } from "@/lib/search/rank";
import { describeChunkLocation } from "@/lib/text/chunk";
import type { DocumentBundle } from "@/lib/storage/documents";

import type { Passage } from "./events";

export type ToolResult = {
  ok: boolean;
  /** One line for the live step log; safe to show a user. */
  summary: string;
  /** Data handed back to the model. */
  data?: unknown;
  error?: string;
};

export type ToolContext = {
  bundles: DocumentBundle[];
  /** Passages collected so far, appended by search_document. */
  passages: Passage[];
  /** Total chunks across the documents in scope. */
  chunksInScope: number;
  nextPassageNumber(): number;
};

export type ToolSpec = {
  name: string;
  description: string;
  parameters: string;
  run(args: unknown, context: ToolContext): Promise<ToolResult>;
};

const MAX_PASSAGE_CHARS = 1400;
const DEFAULT_SEARCH_LIMIT = 4;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optionalDocumentIds(value: unknown, context: ToolContext): string[] | null {
  if (value === undefined || value === null || value === "") return null;
  const list = Array.isArray(value) ? value : [value];
  const ids = list.filter((entry): entry is string => typeof entry === "string");
  const valid = ids.filter((id) => context.bundles.some((bundle) => bundle.record.id === id));
  return valid.length > 0 ? valid : null;
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_PASSAGE_CHARS) return { text, truncated: false };
  const cut = text.slice(0, MAX_PASSAGE_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  const usable = lastSpace > MAX_PASSAGE_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut;
  return { text: `${usable}…`, truncated: true };
}

const searchDocument: ToolSpec = {
  name: "search_document",
  description:
    "Search the full text of the documents in scope and return the most relevant numbered passages. Use the document's own vocabulary: short, specific queries of two to five words work far better than whole sentences.",
  parameters: `{ "query": string (required, 2-8 words), "limit": number (optional, 1-8, default 4), "document_ids": string[] (optional) }`,
  async run(args, context): Promise<ToolResult> {
    const record = asRecord(args);
    const query = asString(record.query).trim();
    if (query.length < 2) {
      return {
        ok: false,
        summary: "Rejected a search with no usable query",
        error: '`query` must be a string of two or more words of real text from the question. Example: {"query": "liability cap"}.',
      };
    }

    const limit = (() => {
      const parsed = typeof record.limit === "number" ? record.limit : Number.parseInt(asString(record.limit), 10);
      if (!Number.isFinite(parsed)) return DEFAULT_SEARCH_LIMIT;
      return Math.min(8, Math.max(1, Math.trunc(parsed)));
    })();

    const documentIds = optionalDocumentIds(record.document_ids, context);
    const chunks = context.bundles.flatMap((bundle) => bundle.chunks);
    const result = searchChunks(query, chunks, { limit, documentIds: documentIds ?? undefined });

    if (result.ranked.length === 0 || result.noMatch) {
      return {
        ok: true,
        summary: `No match for "${query}" (searched ${result.chunksSearched} clauses of ${context.bundles.length} document${context.bundles.length === 1 ? "" : "s"})`,
        data: {
          query,
          match: "none",
          searched: `${result.chunksSearched} clauses across the whole of ${context.bundles.length} document(s)`,
          note: "No passage matched those terms. This means the wording was not found; it does not prove the concept is absent. Try a different phrase from the document, or list_clauses to see what the document contains.",
          passages: [],
        },
      };
    }

    const passages = result.ranked.map((entry) => {
      const bundle = context.bundles.find((candidate) => candidate.record.id === entry.chunk.documentId);
      const { text, truncated } = truncate(entry.chunk.text);
      const passage: Passage = {
        id: `p${context.nextPassageNumber()}`,
        documentId: entry.chunk.documentId,
        documentTitle: bundle?.record.title ?? "document",
        label: describeChunkLocation(entry.chunk),
        start: entry.chunk.start,
        end: entry.chunk.end,
        pageStart: entry.chunk.pageStart,
        pageEnd: entry.chunk.pageEnd,
        score: entry.score,
        text,
        truncated,
      };
      context.passages.push(passage);
      return passage;
    });

    return {
      ok: true,
      summary: `Found ${passages.length} passage${passages.length === 1 ? "" : "s"} for "${query}" (${result.ranked[0]?.reason ?? ""})`.trim(),
      data: {
        query,
        match: "found",
        coverage: `${result.coverage} of the question's terms appear in the top passages`,
        searched: `${result.chunksSearched} clauses across the whole of ${context.bundles.length} document(s)`,
        passages: passages.map((passage) => ({
          id: passage.id,
          document: passage.documentTitle,
          location: passage.label,
          score: passage.score,
          text: passage.text,
          truncated: passage.truncated,
        })),
      },
    };
  },
};

const getSection: ToolSpec = {
  name: "get_section",
  description:
    "Read one clause in full, by its number (for example \"11\" for clause 11, or \"12.4\" for a sub-clause). Use this after a search to read a clause completely, or when the question names a clause number.",
  parameters: `{ "number": string (required, e.g. "11" or "12.4"), "document_id": string (optional) }`,
  async run(args, context): Promise<ToolResult> {
    const record = asRecord(args);
    const raw = asString(record.number).trim().replace(/^clause\s+/i, "").replace(/[^\d.]/g, "");
    if (!/^\d+(\.\d+)*$/.test(raw)) {
      return {
        ok: false,
        summary: "Rejected a section request with no valid number",
        error:
          '`number` must be a clause number such as "11" or "12.4". Call list_clauses first if you do not know which clauses exist.',
      };
    }

    const bundles = optionalDocumentIds(record.document_id, context)?.length
      ? context.bundles.filter((bundle) => bundle.record.id === asString(record.document_id))
      : context.bundles;

    const found: Array<{ bundle: DocumentBundle; text: string; start: number; end: number; label: string }> = [];
    for (const bundle of bundles) {
      const chunks = bundle.chunks.filter(
        (chunk) => chunk.clauseNumber === raw || chunk.clauseNumber === raw.split(".")[0],
      );
      if (chunks.length === 0) continue;
      const first = chunks[0];
      const last = chunks[chunks.length - 1];
      if (!first || !last) continue;
      const start = first.start;
      const end = last.end;
      found.push({
        bundle,
        text: bundle.document.text.slice(start, end),
        start,
        end,
        label: describeChunkLocation(first),
      });
    }

    if (found.length === 0) {
      const available = context.bundles
        .flatMap((bundle) => bundle.clauses.map((clause) => clause.number))
        .filter((number): number is string => Boolean(number))
        .slice(0, 40)
        .join(", ");
      return {
        ok: true,
        summary: `Clause ${raw} was not found`,
        data: {
          match: "none",
          note: `No clause ${raw} exists in the documents in scope. Clauses present include: ${available || "none detected"}.`,
        },
      };
    }

    return {
      ok: true,
      summary: `Read clause ${raw} in full (${found.length} document${found.length === 1 ? "" : "s"})`,
      data: {
        match: "found",
        sections: found.map((entry) => {
          const { text, truncated } = truncate(entry.text);
          return {
            document: entry.bundle.record.title,
            document_id: entry.bundle.record.id,
            location: entry.label,
            start: entry.start,
            end: entry.end,
            text,
            truncated,
          };
        }),
      },
    };
  },
};

const listClauses: ToolSpec = {
  name: "list_clauses",
  description:
    "List the clause numbers and headings of the documents in scope. Use this to learn what a document covers before concluding that something is missing, or to find the right clause to read.",
  parameters: `{ "document_id": string (optional) }`,
  async run(args, context): Promise<ToolResult> {
    const record = asRecord(args);
    const documentId = asString(record.document_id);
    const bundles = documentId ? context.bundles.filter((bundle) => bundle.record.id === documentId) : context.bundles;

    if (bundles.length === 0) {
      return { ok: false, summary: "No such document", error: "That document id is not in scope for this question." };
    }

    return {
      ok: true,
      summary: `Listed ${bundles.reduce((total, bundle) => total + bundle.clauses.length, 0)} clauses`,
      data: {
        documents: bundles.map((bundle) => ({
          document: bundle.record.title,
          document_id: bundle.record.id,
          pages: bundle.record.pageCount,
          clauses: bundle.clauses
            .filter((clause) => clause.number !== null)
            .slice(0, 80)
            .map((clause) => ({
              number: clause.number,
              heading: clause.heading ?? "(no heading)",
              page: clause.pageStart,
            })),
        })),
      },
    };
  },
};

const getDocumentOverview: ToolSpec = {
  name: "get_document_overview",
  description:
    "Get the shape of the documents in scope: titles, page counts, clause counts, and any extraction warnings. Use this when a question is about the document as a whole.",
  parameters: `{}`,
  async run(_args, context): Promise<ToolResult> {
    return {
      ok: true,
      summary: `Described ${context.bundles.length} document${context.bundles.length === 1 ? "" : "s"} in scope`,
      data: {
        documents: context.bundles.map((bundle) => ({
          document_id: bundle.record.id,
          title: bundle.record.title,
          kind: bundle.record.kind,
          pages: bundle.record.pageCount,
          clauses: bundle.record.clauseCount,
          characters: bundle.record.charCount,
          warnings: bundle.record.warnings,
        })),
      },
    };
  },
};

export const TOOLS: ToolSpec[] = [searchDocument, getSection, listClauses, getDocumentOverview];

export function toolNames(): string[] {
  return TOOLS.map((tool) => tool.name);
}

export function findTool(name: string): ToolSpec | null {
  return TOOLS.find((tool) => tool.name === name) ?? null;
}

export const FINAL_ANSWER_TOOL = "final_answer";

/** Rendered into both system prompts so the model always sees the real list. */
export function describeTools(): string {
  return TOOLS.map((tool) => `- ${tool.name}: ${tool.description}\n  arguments: ${tool.parameters}`).join("\n");
}
