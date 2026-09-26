/**
 * Loading a stored document into the searchable form the rest of the app uses.
 *
 * Chunking a 150-page contract takes about a tenth of a second and the result is
 * deterministic, so bundles are cached per process. Documents are immutable once
 * stored, so the cache needs no invalidation beyond dropping the entry on delete.
 */

import { chunkDocument, extractClauseOutline, type Chunk, type ClauseOutline } from "@/lib/text/chunk";
import { createSearchableDocument, type SearchableDocument } from "@/lib/text/document";
import { getDocumentRecord, getManyDocumentRecords } from "@/lib/storage/repository";
import type { DocumentRecord, StoredDocument } from "@/lib/types";

export type DocumentBundle = {
  record: DocumentRecord;
  document: SearchableDocument;
  chunks: Chunk[];
  clauses: ClauseOutline[];
};

const CACHE_LIMIT = 4;
const cache = new Map<string, DocumentBundle>();

function toBundle(record: DocumentRecord): DocumentBundle {
  const document = createSearchableDocument({
    id: record.id,
    title: record.title,
    text: record.text,
    pages: record.pages,
  });
  return {
    record,
    document,
    chunks: chunkDocument(document),
    clauses: extractClauseOutline(document),
  };
}

function remember(bundle: DocumentBundle): DocumentBundle {
  cache.delete(bundle.record.id);
  cache.set(bundle.record.id, bundle);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return bundle;
}

export async function loadDocumentBundle(id: string): Promise<DocumentBundle | null> {
  const cached = cache.get(id);
  if (cached) return cached;
  const record = await getDocumentRecord(id);
  return record ? remember(toBundle(record)) : null;
}

export async function loadDocumentBundles(ids: string[]): Promise<DocumentBundle[]> {
  const missing = ids.filter((id) => !cache.has(id));
  if (missing.length > 0) {
    for (const record of await getManyDocumentRecords(missing)) remember(toBundle(record));
  }
  return ids.map((id) => cache.get(id)).filter((bundle): bundle is DocumentBundle => Boolean(bundle));
}

export function forgetDocumentBundle(id: string): void {
  cache.delete(id);
}

export function toStoredDocument(record: DocumentRecord): StoredDocument {
  const { contentHash, fileBase64, text, pages, ...rest } = record;
  void contentHash;
  void fileBase64;
  void text;
  void pages;
  return rest;
}
