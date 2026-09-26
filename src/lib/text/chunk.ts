/**
 * Chunking.
 *
 * A 150-page contract does not fit in one request, so the text has to be split
 * — but *where* it is split matters more than how small the pieces are. Legal
 * documents are already divided into numbered clauses, and an answer is only
 * trustworthy if it can cite a clause rather than "somewhere in the middle of
 * page 74". So the splitter follows the document's own structure:
 *
 *   lines -> blocks (one per numbered sub-clause) -> clauses -> chunks
 *
 * Chunks never cross a top-level clause boundary; a clause that is too long is
 * split at a sentence boundary instead, so no chunk ends mid-sentence.
 *
 * Every chunk keeps `start`/`end` offsets into the full document text. That is
 * deliberate: retrieval only ever *finds* text, while quote verification always
 * searches the entire document. A quote that happens to span two chunks is
 * therefore still verified correctly — the chunking decides what the model
 * reads, never what counts as present.
 */

import { type SearchableDocument, pageForOffset } from "./document";
import { normalizeText } from "./normalize";

export type Chunk = {
  id: string;
  documentId: string;
  /** Position within the document, 0-based. */
  ordinal: number;
  /** Top-level clause number, e.g. "11" for clause 11.1. Null when unnumbered. */
  clauseNumber: string | null;
  /** Clause heading, e.g. "LIMITATION OF LIABILITY". */
  heading: string | null;
  start: number;
  end: number;
  pageStart: number | null;
  pageEnd: number | null;
  text: string;
  tokenCount: number;
};

export type ChunkOptions = {
  /** Soft ceiling on chunk size. Roughly 500 tokens at 4 characters per token. */
  maxChars?: number;
};

const DEFAULT_MAX_CHARS = 2000;
/** Sentence boundary: keeps a split from landing mid-sentence. */
const SENTENCE_PATTERN = /[^.!?]*[.!?]+["'”’)\]]*\s*|[^.!?]+$/g;

/** "11. LIMITATION OF LIABILITY" — a numbered clause heading. */
const CLAUSE_HEADING = /^(\d+(?:\.\d+)*)\.?\s+([A-Z][A-Z0-9 ,&'’()\-/.]{2,})$/;
/** "11.1 Subject to clause 11.3 ..." — a numbered sub-clause. */
const NUMBERED_PARAGRAPH = /^(\d+(?:\.\d+)*)\.?\s+\S/;
/** "SCHEDULE 3 — SUPPLEMENTAL TERMS", "ARTICLE 5", "ANNEX A" */
const ALL_CAPS_HEADING = /^(?:SCHEDULE|ARTICLE|SECTION|ANNEX|APPENDIX|EXHIBIT|PART)\b.*$|^[A-Z][A-Z0-9 ,&'’()\-/—]{3,}$/;

export type TextBlock = {
  start: number;
  end: number;
  text: string;
  clauseNumber: string | null;
  topClause: string | null;
  heading: string | null;
};

function topLevelClause(clauseNumber: string | null): string | null {
  if (!clauseNumber) return null;
  const [first] = clauseNumber.split(".");
  return first ?? null;
}

/**
 * Split the document into blocks at the points the document itself defines:
 * numbered sub-clauses and headings. Body lines are appended to the block they
 * belong to, offsets preserved exactly.
 */
export function splitIntoBlocks(document: SearchableDocument): TextBlock[] {
  const text = document.text;
  const blocks: TextBlock[] = [];

  let currentStart = -1;
  let currentEnd = 0;
  let currentClause: string | null = null;
  let currentTop: string | null = null;
  let currentHeading: string | null = null;

  const flush = () => {
    if (currentStart === -1) return;
    const raw = text.slice(currentStart, currentEnd);
    if (raw.trim().length > 0) {
      blocks.push({
        start: currentStart,
        end: currentEnd,
        text: raw,
        clauseNumber: currentClause,
        topClause: currentTop,
        heading: currentHeading,
      });
    }
    currentStart = -1;
    currentEnd = 0;
    currentClause = null;
    currentTop = null;
    currentHeading = null;
  };

  let offset = 0;
  for (const line of text.split("\n")) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    offset = lineEnd + 1;
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      // A blank line ends a block only when the block looks finished; PDF
      // extraction inserts blanks that do not correspond to paragraph ends.
      if (currentStart !== -1 && /[.;:”")\]]$/.test(text.slice(currentStart, currentEnd).trimEnd())) {
        flush();
      }
      continue;
    }

    const headingMatch = CLAUSE_HEADING.exec(trimmed);
    const numberedMatch = NUMBERED_PARAGRAPH.exec(trimmed);
    const isAllCapsHeading = ALL_CAPS_HEADING.test(trimmed) && trimmed.length <= 90;

    const startsNewBlock = Boolean(headingMatch || numberedMatch || (isAllCapsHeading && currentStart !== -1));

    if (startsNewBlock && currentStart !== -1) flush();

    if (currentStart === -1) {
      currentStart = lineStart;
      // A numbered heading names the clause; otherwise fall back to an all-caps
      // line such as "SCHEDULE 3 — SUPPLEMENTAL TERMS".
      const headingText = (headingMatch?.[2] ?? "").trim() || null;
      currentHeading = headingText ?? (isAllCapsHeading ? trimmed : null);
      const clause = headingMatch?.[1] ?? numberedMatch?.[1] ?? null;
      currentClause = clause;
      currentTop = topLevelClause(clause);
    } else if (headingMatch) {
      // A later heading inside the same block still names the clause.
      currentHeading = currentHeading ?? ((headingMatch[2] ?? "").trim() || null);
    }

    currentEnd = lineEnd;
  }
  flush();

  return blocks;
}

/** Group consecutive blocks that belong to the same top-level clause. */
function groupByClause(blocks: TextBlock[]): TextBlock[][] {
  const groups: TextBlock[][] = [];
  let group: TextBlock[] = [];

  for (const block of blocks) {
    const previous = group[group.length - 1];
    const sameClause =
      group.length === 0 ||
      block.topClause === null ||
      previous?.topClause === null ||
      block.topClause === previous?.topClause;

    if (!sameClause) {
      groups.push(group);
      group = [];
    }
    group.push(block);
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

/** Cut one oversized paragraph at sentence ends, keeping offsets exact. */
function splitOversizedBlock(block: TextBlock, maxChars: number): TextBlock[] {
  const sentences = block.text.match(SENTENCE_PATTERN) ?? [block.text];
  const pieces: TextBlock[] = [];
  let offsetInBlock = 0;
  let buffered = "";

  const flush = () => {
    if (buffered.length === 0) return;
    pieces.push({
      ...block,
      start: block.start + offsetInBlock,
      end: block.start + offsetInBlock + buffered.length,
      text: buffered,
    });
    offsetInBlock += buffered.length;
    buffered = "";
  };

  for (const sentence of sentences) {
    if (buffered.length > 0 && buffered.length + sentence.length > maxChars) flush();
    buffered += sentence;
  }
  flush();
  return pieces;
}

/**
 * Pack a group's blocks into chunks up to `maxChars`, splitting any single
 * paragraph that is itself larger than the budget.
 */
function splitLongGroup(group: TextBlock[], maxChars: number): TextBlock[][] {
  const pieces: TextBlock[] = [];
  for (const block of group) {
    if (block.end - block.start > maxChars) {
      pieces.push(...splitOversizedBlock(block, maxChars));
    } else {
      pieces.push(block);
    }
  }

  const groups: TextBlock[][] = [];
  let current: TextBlock[] = [];
  let size = 0;
  for (const piece of pieces) {
    const length = piece.end - piece.start;
    if (current.length > 0 && size + length > maxChars) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(piece);
    size += length;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

export function chunkDocument(
  document: SearchableDocument,
  options: ChunkOptions = {},
): Chunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const blocks = splitIntoBlocks(document);
  const groups = groupByClause(blocks);
  const chunks: Chunk[] = [];

  for (const group of groups) {
    for (const piece of splitLongGroup(group, maxChars)) {
      const first = piece[0];
      const last = piece[piece.length - 1];
      if (!first || !last) continue;
      const start = first.start;
      const end = last.end;
      const text = document.text.slice(start, end);
      if (text.trim().length === 0) continue;

      chunks.push({
        id: `${document.id}:${chunks.length}`,
        documentId: document.id,
        ordinal: chunks.length,
        clauseNumber: first.topClause ?? first.clauseNumber,
        heading: piece.find((block) => block.heading)?.heading ?? null,
        start,
        end,
        pageStart: pageForOffset(document.pages, start),
        pageEnd: pageForOffset(document.pages, Math.max(start, end - 1)),
        text,
        tokenCount: normalizeText(text).text.split(" ").filter(Boolean).length,
      });
    }
  }

  return chunks;
}

/** Where a chunk sits, in words a person can check: "clause 11, page 4". */
export function describeChunkLocation(chunk: Chunk): string {
  const parts: string[] = [];
  if (chunk.clauseNumber) parts.push(`clause ${chunk.clauseNumber}`);
  if (chunk.heading) parts.push(chunk.heading.toLowerCase());
  if (chunk.pageStart !== null) {
    parts.push(
      chunk.pageEnd !== null && chunk.pageEnd !== chunk.pageStart
        ? `pages ${chunk.pageStart}-${chunk.pageEnd}`
        : `page ${chunk.pageStart}`,
    );
  }
  return parts.length > 0 ? parts.join(", ") : `chunk ${chunk.ordinal + 1}`;
}

export type ClauseOutline = {
  number: string | null;
  heading: string | null;
  start: number;
  end: number;
  pageStart: number | null;
  pageEnd: number | null;
};

/** The document's table of clauses — used by the `list_clauses` agent tool. */
export function extractClauseOutline(document: SearchableDocument): ClauseOutline[] {
  const blocks = splitIntoBlocks(document);
  const outline: ClauseOutline[] = [];

  for (const block of blocks) {
    const key = block.topClause ?? block.clauseNumber;
    const previous = outline[outline.length - 1];
    if (previous && previous.number === key) {
      previous.end = block.end;
      previous.pageEnd = pageForOffset(document.pages, Math.max(block.start, block.end - 1));
      if (!previous.heading && block.heading) previous.heading = block.heading;
      continue;
    }
    outline.push({
      number: key,
      heading: block.heading,
      start: block.start,
      end: block.end,
      pageStart: pageForOffset(document.pages, block.start),
      pageEnd: pageForOffset(document.pages, Math.max(block.start, block.end - 1)),
    });
  }

  return outline.filter((clause) => clause.number !== null || clause.heading !== null);
}

export function pagesCoveredBy(chunks: Chunk[]): { first: number | null; last: number | null } {
  const numbers = chunks.flatMap((chunk) => [chunk.pageStart, chunk.pageEnd]).filter((n): n is number => n !== null);
  if (numbers.length === 0) return { first: null, last: null };
  return { first: Math.min(...numbers), last: Math.max(...numbers) };
}
