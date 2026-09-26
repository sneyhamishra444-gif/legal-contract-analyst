/**
 * The document model the search and verification layers work against.
 *
 * A document is stored as one flat string plus a list of page spans, because
 * every requirement here is offset-based: quotes must be located in the text,
 * highlighted in the reader, and attributed to a page. Page spans are ranges
 * into that flat string, so a quote that runs across a page break is not a
 * special case — it is simply a range that happens to cross a boundary.
 */

import { type NormalizedText, normalizeText } from "./normalize";

export type PageSpan = {
  /** 1-based page number as a person would count pages. */
  number: number;
  /** Offset into `SearchableDocument.text` where this page starts (inclusive). */
  start: number;
  /** Offset where this page ends (exclusive). */
  end: number;
};

export type TokenIndex = {
  /** Lowercased token text, in order of appearance. */
  lower: string[];
  /** Offset into the original text where each token starts. */
  starts: Int32Array;
  /** Offset just past the end of each token. */
  ends: Int32Array;
};

export type SearchableDocument = {
  id: string;
  title: string;
  /** Full extracted text. Pages are joined by a single newline. */
  text: string;
  pages: PageSpan[];
  normalized: NormalizedText;
  /** A second normalisation that also joins words hyphenated across a line break. */
  hyphenJoined: NormalizedText;
  /** Built on first use — roughly 5 tokens per 30 characters of text. */
  tokenIndex: TokenIndex | null;
};

/**
 * Join per-page extracted text into one string while recording where each page
 * lands, so offsets can be attributed back to a page later.
 */
export function buildPaginatedText(pageTexts: string[]): { text: string; pages: PageSpan[] } {
  const pages: PageSpan[] = [];
  let text = "";
  pageTexts.forEach((pageText, index) => {
    const cleaned = pageText.replace(/\r\n?/g, "\n").trim();
    if (index > 0) text += "\n";
    const start = text.length;
    text += cleaned;
    pages.push({ number: index + 1, start, end: text.length });
  });
  return { text, pages };
}

export function createSearchableDocument(input: {
  id: string;
  title: string;
  text: string;
  pages?: PageSpan[];
}): SearchableDocument {
  return {
    id: input.id,
    title: input.title,
    text: input.text,
    pages: input.pages ?? [],
    normalized: normalizeText(input.text),
    hyphenJoined: normalizeText(input.text, { joinLineBreakHyphens: true }),
    tokenIndex: null,
  };
}

/** Which page (1-based) contains `offset`. Null when the document has no page map. */
export function pageForOffset(pages: PageSpan[], offset: number): number | null {
  if (pages.length === 0) return null;
  let low = 0;
  let high = pages.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const page = pages[mid];
    if (!page) return null;
    if (offset < page.start) {
      high = mid - 1;
    } else if (offset >= page.end) {
      low = mid + 1;
    } else {
      return page.number;
    }
  }
  // Offsets on a boundary (or past the end) belong to the nearest page.
  const fallback = offset < (pages[0]?.start ?? 0) ? pages[0] : pages[pages.length - 1];
  return fallback?.number ?? null;
}

/** Does the range cross a page boundary? */
export function spansMultiplePages(pages: PageSpan[], start: number, end: number): boolean {
  const first = pageForOffset(pages, start);
  const last = pageForOffset(pages, Math.max(start, end - 1));
  return first !== null && last !== null && first !== last;
}

const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

export function getTokenIndex(document: SearchableDocument): TokenIndex {
  if (document.tokenIndex) return document.tokenIndex;

  const lower: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];

  TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_PATTERN.exec(document.text)) !== null) {
    lower.push(match[0].toLowerCase());
    starts.push(match.index);
    ends.push(match.index + match[0].length);
    if (match.index === TOKEN_PATTERN.lastIndex) TOKEN_PATTERN.lastIndex += 1;
  }

  document.tokenIndex = {
    lower,
    starts: Int32Array.from(starts),
    ends: Int32Array.from(ends),
  };
  return document.tokenIndex;
}
