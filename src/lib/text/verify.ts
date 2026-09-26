/**
 * Quote verification.
 *
 * Every quote shown to the user passes through here first, and a quote only
 * counts as verified when its words are found in the document. Positions come
 * from our own search — a page number, offset or span reported by a model is
 * never read, because a model that invents a quote will happily invent its
 * location too. The verification layer is the only thing in this codebase that
 * is allowed to say where a quote is.
 *
 * Matching is layered, from strict to tolerant:
 *
 *   1. exact                 — the words match, after folding whitespace,
 *                              line breaks and typographic variants.
 *   2. case-insensitive      — same words, differing only in capitalisation.
 *   3. punctuation-trimmed   — the model added or dropped sentence punctuation
 *                              at the edges of a quote.
 *   4. hyphen-joined         — the document hyphenated a word across a line
 *                              break ("indemnifi-\ncation").
 *
 * Layers 1 and 2 differ only in case. Layer 3 only removes punctuation from the
 * *ends* of a quote. Layer 4 only joins a word that was split. None of them can
 * reorder, substitute or drop a word, so a paraphrase fails at every layer —
 * which is the entire point. Anything that fails is reported as unverified,
 * along with the nearest passage we could find and how similar it is, so the
 * user can see what the model was probably reaching for without ever being
 * shown it as a quotation.
 */

import {
  type PageSpan,
  type SearchableDocument,
  getTokenIndex,
  pageForOffset,
  spansMultiplePages,
} from "./document";
import { type NormalizedText, normalizeText, toOriginalRange } from "./normalize";

export type QuoteStatus = "verified" | "partial" | "unverified";

export type MatchMethod =
  | "exact"
  | "case-insensitive"
  | "punctuation-trimmed"
  | "hyphen-joined"
  | "none";

export type VerifiedSpan = {
  /** The original characters this span covers, exactly as they appear in the document. */
  text: string;
  /** Offset into `SearchableDocument.text`. */
  start: number;
  /** Offset just past the end. */
  end: number;
  pageStart: number | null;
  pageEnd: number | null;
};

export type QuoteVerification = {
  /** The quote exactly as it was supplied, for display alongside the verdict. */
  raw: string;
  status: QuoteStatus;
  method: MatchMethod;
  /** Verified spans in document order. Empty when nothing was found. */
  spans: VerifiedSpan[];
  /** Parts of the quote that could not be located, as written. */
  failedSegments: string[];
  /** Overall span: first verified character to last. Null when nothing was found. */
  start: number | null;
  end: number | null;
  pageStart: number | null;
  pageEnd: number | null;
  crossPage: boolean;
  multiLine: boolean;
  /** How many times this wording appears in the document. */
  occurrences: number;
  /** Other places the same wording appears, so the reader can step through them. */
  alternatives: Array<{ start: number; end: number }>;
  /** 0..1 token-overlap score against the closest passage. 1 when verified. */
  similarity: number;
  /** Nearest passage when the quote could not be verified. Reference only. */
  closest: VerifiedSpan | null;
  /** A quote this short is technically verified but proves very little. */
  weakEvidence: boolean;
  /** Plain-language remarks for the interface. */
  notes: string[];
};

export type VerifyOptions = {
  /**
   * Ranges the answer was actually drawn from. When a quote appears more than
   * once, the occurrence overlapping these ranges is preferred, so "click the
   * quote" opens the passage the answer was built from rather than the first
   * accidental repeat of the same sentence elsewhere in the document.
   */
  preferredRanges?: Array<{ start: number; end: number }>;
};

/** Cap on occurrences reported to the user. */
const MAX_OCCURRENCES = 200;
/**
 * Cap on candidate positions considered while matching.
 *
 * This has to be generous when the caller says which passage the answer came
 * from. Considered only in document order, the passage the answer actually used
 * may be the forty-fifth repetition of the same sentence — a real pattern in
 * long contracts, where schedules repeat standard clauses — and a low cap would
 * silently pin every citation to the first one.
 */
const MAX_CANDIDATES_WITH_PREFERENCE = 800;
const SHORT_QUOTE_CHARS = 24;
const FUZZY_MIN_SCORE = 0.45;

/** Quotes arrive broken by ellipses, or with bracketed editorial insertions. */
const ELISION_PATTERN = /(?:\.\s*){2,}|…|\[\s*(?:…|(?:\.\s*){2,})\s*\]/g;
const LEADING_NOISE = /^[\s"'`""''«».,;:!?()[\]{}—–-]+/;
const TRAILING_NOISE = /[\s"'`""''«».,;:!?()[\]{}—–-]+$/;
/** A short bracketed phrase, e.g. "[the Supplier]" — an insertion, not the document's words. */
const BRACKETED_PHRASE = /\[[^\]]{1,60}\]/g;

type SegmentSpec = {
  /** As written, after trimming noise. */
  raw: string;
  /** Normalised (case-preserved) — used to decide exact vs case-insensitive. */
  normalized: string;
  /** Normalised and lowercased — used to search. */
  needle: string;
};

type MatchedSegment = {
  index: number;
  /** Offsets in the normalised coordinate space of the variant that matched. */
  start: number;
  end: number;
  exact: boolean;
};

type Attempt = {
  /** Which normalised variant produced these offsets — required to map back correctly. */
  variant: NormalizedText;
  matched: MatchedSegment[];
  failed: Array<{ index: number; raw: string }>;
  method: MatchMethod;
};

function toSegmentSpecs(rawSegments: string[], trim: boolean): SegmentSpec[] {
  return rawSegments.map((raw) => {
    const cleaned = trim ? trimNoise(raw) : raw;
    const normalizedText = normalizeText(cleaned);
    return { raw: cleaned, normalized: normalizedText.text, needle: normalizedText.lower };
  });
}

function trimNoise(value: string): string {
  return value.replace(LEADING_NOISE, "").replace(TRAILING_NOISE, "").trim();
}

/** Split a quote on ellipses and bracketed ellipses. */
export function splitQuoteIntoSegments(raw: string): string[] {
  return raw
    .split(ELISION_PATTERN)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function findAllOccurrences(haystack: string, needle: string, limit = MAX_OCCURRENCES): number[] {
  if (!needle) return [];
  const found: number[] = [];
  let from = 0;
  while (found.length < limit) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    found.push(index);
    from = index + 1;
  }
  return found;
}

/** Rank candidate start positions: overlapping the answer's sources first, then in order. */
function rankCandidates(
  candidates: number[],
  length: number,
  preferredRanges: Array<{ start: number; end: number }>,
  normalized: NormalizedText,
): number[] {
  if (preferredRanges.length === 0) return candidates;
  const scored = candidates.map((candidate) => {
    const range = toOriginalRange(normalized, candidate, candidate + length);
    let overlap = 0;
    for (const preferred of preferredRanges) {
      overlap += Math.max(
        0,
        Math.min(range.end, preferred.end) - Math.max(range.start, preferred.start),
      );
    }
    return { candidate, overlap };
  });
  scored.sort((a, b) => b.overlap - a.overlap || a.candidate - b.candidate);
  return scored.map((entry) => entry.candidate);
}

/**
 * Try to locate every segment, in order, in one normalised variant.
 *
 * A candidate position for the first segment is only accepted if the remaining
 * segments can then be found after it — which is what keeps a repeated sentence
 * from being stitched onto the wrong occurrence of the next one.
 */
function attemptVariant(
  variant: NormalizedText,
  specs: SegmentSpec[],
  preferredRanges: Array<{ start: number; end: number }>,
  method: MatchMethod,
): Attempt {
  const first = specs[0];
  if (!first) return { variant, matched: [], failed: [], method };

  const candidates = rankCandidates(
    findAllOccurrences(
      variant.lower,
      first.needle,
      preferredRanges.length > 0 ? MAX_CANDIDATES_WITH_PREFERENCE : MAX_OCCURRENCES,
    ),
    first.needle.length,
    preferredRanges,
    variant,
  );

  const best: Attempt = {
    variant,
    matched: [],
    failed: specs.map((spec, index) => ({ index, raw: spec.raw })),
    method,
  };

  const walk = (candidate: number): MatchedSegment[] | null => {
    const matched: MatchedSegment[] = [];
    let cursor = candidate;
    for (let index = 0; index < specs.length; index += 1) {
      const spec = specs[index];
      if (!spec) continue;
      const position =
        index === 0 ? candidate : variant.lower.indexOf(spec.needle, cursor);
      if (position === -1) return null;
      const exact = variant.text.slice(position, position + spec.normalized.length) === spec.normalized;
      matched.push({ index, start: position, end: position + spec.needle.length, exact });
      cursor = position + spec.needle.length;
    }
    return matched;
  };

  for (const candidate of candidates) {
    const matched = walk(candidate);
    if (matched) return { variant, matched, failed: [], method };
  }

  // Nothing matched end to end. Rather than discard the quote, find which parts
  // of it *are* in the document, so a half-real quote can be reported as
  // half-real instead of as either a quotation or a total fabrication. Each part
  // is searched from where the previous found part ended, which preserves order
  // without requiring the parts to be adjacent.
  const matched: MatchedSegment[] = [];
  const failed: Array<{ index: number; raw: string }> = [];
  let cursor = 0;
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index];
    if (!spec) continue;
    const position = variant.lower.indexOf(spec.needle, cursor);
    if (position === -1) {
      failed.push({ index, raw: spec.raw });
      continue;
    }
    const exact = variant.text.slice(position, position + spec.normalized.length) === spec.normalized;
    matched.push({ index, start: position, end: position + spec.needle.length, exact });
    cursor = position + spec.needle.length;
  }

  return matched.length > best.matched.length ? { variant, matched, failed, method } : best;
}

/**
 * Closest passage by token overlap, for showing what the model may have meant.
 * Deliberately token-based rather than word-for-word: a paraphrase scores high
 * here and must never count as a quote, which is exactly why it is only ever
 * reported as `closest`, never as a match.
 */
function closestPassage(
  document: SearchableDocument,
  needleText: string,
): { span: VerifiedSpan; score: number } | null {
  const tokens = getTokenIndex(document);
  const needleTokens = needleText
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((token) => token.length > 0);
  if (!needleTokens || needleTokens.length === 0 || tokens.lower.length === 0) return null;

  const needleCounts = new Map<string, number>();
  for (const token of needleTokens) needleCounts.set(token, (needleCounts.get(token) ?? 0) + 1);

  const m = needleTokens.length;
  const minLength = Math.max(3, m - Math.ceil(m * 0.3));
  const maxLength = m + Math.ceil(m * 0.3);
  const budget = 24_000;
  const stride = Math.max(1, Math.ceil(tokens.lower.length / budget));

  let bestScore = 0;
  let bestStart = 0;
  let bestEnd = 0;

  for (let start = 0; start < tokens.lower.length; start += stride) {
    for (let length = minLength; length <= maxLength; length += 1) {
      const end = start + length;
      if (end > tokens.lower.length) break;
      const window = new Map<string, number>();
      for (let i = start; i < end; i += 1) {
        const token = tokens.lower[i];
        if (token) window.set(token, (window.get(token) ?? 0) + 1);
      }
      let shared = 0;
      for (const [token, count] of needleCounts) {
        shared += Math.min(count, window.get(token) ?? 0);
      }
      const precision = shared / length;
      const recall = shared / m;
      const score = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
      if (score > bestScore) {
        bestScore = score;
        bestStart = start;
        bestEnd = end;
      }
    }
  }

  if (bestScore < FUZZY_MIN_SCORE) return null;
  const startOffset = tokens.starts[bestStart];
  const endOffset = tokens.ends[bestEnd - 1];
  if (startOffset === undefined || endOffset === undefined) return null;

  return {
    score: Number(bestScore.toFixed(3)),
    span: {
      text: document.text.slice(startOffset, endOffset),
      start: startOffset,
      end: endOffset,
      pageStart: pageForOffset(document.pages, startOffset),
      pageEnd: pageForOffset(document.pages, Math.max(startOffset, endOffset - 1)),
    },
  };
}

function describeMethod(method: MatchMethod): string | null {
  switch (method) {
    case "case-insensitive":
      return "Words match exactly; only capitalisation differs from the document.";
    case "punctuation-trimmed":
      return "Words match exactly; sentence punctuation at the edges of the quote was added or dropped.";
    case "hyphen-joined":
      return "Words match once a word hyphenated across a line break is joined back together.";
    default:
      return null;
  }
}

/** Build a VerifiedSpan from a normalised-coordinate match. */
function spanFrom(
  variant: NormalizedText,
  pages: PageSpan[],
  matched: MatchedSegment[],
): { spans: VerifiedSpan[]; start: number; end: number } {
  const spans: VerifiedSpan[] = matched.map((entry) => {
    const range = toOriginalRange(variant, entry.start, entry.end);
    return {
      text: variant.original.slice(range.start, range.end),
      start: range.start,
      end: range.end,
      pageStart: pageForOffset(pages, range.start),
      pageEnd: pageForOffset(pages, Math.max(range.start, range.end - 1)),
    };
  });
  const start = spans[0]?.start ?? 0;
  const end = spans[spans.length - 1]?.end ?? 0;
  return { spans, start, end };
}

export function verifyQuote(
  rawQuote: string,
  document: SearchableDocument,
  options: VerifyOptions = {},
): QuoteVerification {
  const raw = rawQuote.trim();
  const preferredRanges = options.preferredRanges ?? [];
  const notes: string[] = [];

  const base: QuoteVerification = {
    raw,
    status: "unverified",
    method: "none",
    spans: [],
    failedSegments: [],
    start: null,
    end: null,
    pageStart: null,
    pageEnd: null,
    crossPage: false,
    multiLine: false,
    occurrences: 0,
    alternatives: [],
    similarity: 0,
    closest: null,
    weakEvidence: false,
    notes,
  };

  if (!raw) {
    notes.push("The answer contained an empty quote, which cannot be verified.");
    return base;
  }

  // A bracketed phrase inside a quote ("the Client shall pay [the Supplier]
  // within 30 days") is the model paraphrasing mid-quotation. It is treated as
  // an elision — the words on either side still have to be found, adjacent to
  // nothing — rather than being deleted, which would leave the quote
  // non-adjacent and therefore unmatchable even when it is entirely genuine.
  const withElisions = raw.replace(BRACKETED_PHRASE, " ... ");
  const hadBracketedInsertion = withElisions !== raw;

  const rawSegments = splitQuoteIntoSegments(hadBracketedInsertion ? withElisions : raw);
  const segments = rawSegments.length > 0 ? rawSegments : [raw];

  const layers: Array<{ variant: NormalizedText; trim: boolean; method: MatchMethod }> = [
    { variant: document.normalized, trim: false, method: "exact" },
    { variant: document.normalized, trim: true, method: "punctuation-trimmed" },
    { variant: document.hyphenJoined, trim: true, method: "hyphen-joined" },
  ];

  let best: Attempt | null = null;
  let chosen: Attempt | null = null;

  for (const layer of layers) {
    const specs = toSegmentSpecs(segments, layer.trim);
    if (specs.every((spec) => spec.needle.length === 0)) continue;
    const attempt = attemptVariant(layer.variant, specs, preferredRanges, layer.method);
    if (!best || attempt.matched.length > best.matched.length) best = attempt;
    if (attempt.failed.length === 0 && attempt.matched.length > 0) {
      chosen = attempt;
      break;
    }
  }

  if (!chosen) {
    const partial = best && best.matched.length > 0 ? best : null;
    const closest = closestPassage(document, segments.join(" "));
    return {
      ...base,
      status: partial ? "partial" : "unverified",
      method: partial ? partial.method : "none",        spans: partial
        ? spanFrom(partial.variant, document.pages, partial.matched).spans
        : [],
      failedSegments: partial ? partial.failed.map((entry) => entry.raw) : segments,
      start: null,
      end: null,
      pageStart: null,
      pageEnd: null,
      similarity: closest?.score ?? 0,
      closest: closest?.span ?? null,
      notes: [
        partial
          ? `${partial.matched.length} of ${segments.length} parts of this quote were found; the rest could not be located.`
          : "This wording is not in the document text.",
        closest
          ? `Closest passage is only ${Math.round((closest.score ?? 0) * 100)}% similar, so it is not a quotation.`
          : "No similar passage was found anywhere in the document.",
      ],
    };
  }

  const variant =
    chosen.method === "hyphen-joined" ? document.hyphenJoined : document.normalized;
  const { spans, start, end } = spanFrom(variant, document.pages, chosen.matched);

  const first = chosen.matched[0];
  const occurrencePositions = first
    ? findAllOccurrences(variant.lower, normalizeText(segments[0] ?? raw).lower)
    : [];
  const alternatives = occurrencePositions
    .map((position) => toOriginalRange(variant, position, position + (first?.end ?? 0) - (first?.start ?? 0)))
    .filter((range) => range.start !== start)
    .map((range) => ({ start: range.start, end: range.end }));

  // The layer that succeeded tells us what had to be tolerated; the per-segment
  // case check only refines the strictest layer. Reporting the layer matters:
  // "matched after joining a hyphenated line break" is information the reader
  // deserves, and overwriting it with "exact" would hide it.
  const exactCase = chosen.matched.every((entry) => entry.exact);
  const method: MatchMethod =
    chosen.method === "exact" ? (exactCase ? "exact" : "case-insensitive") : chosen.method;
  const originalSlice = document.text.slice(start, end);
  const crossPage = spansMultiplePages(document.pages, start, end);
  const multiLine = originalSlice.includes("\n");

  if (hadBracketedInsertion) {
    notes.push(
      "A bracketed insertion inside the quote was treated as elided text; the words on either side were verified.",
    );
  }
  if (method === "case-insensitive" && chosen.method === "exact") {
    notes.push(describeMethod("case-insensitive") ?? "Words match exactly; only capitalisation differs.");
  }
  if (chosen.method !== "exact" && chosen.method !== "case-insensitive") {
    const description = describeMethod(chosen.method);
    if (description) notes.push(description);
  }
  if (originalSlice !== raw && chosen.method === "exact") {
    notes.push("The wording is exact; spacing, line breaks or punctuation styling differ from the quote as written.");
  }
  if (crossPage) {
    notes.push(`This quote crosses a page break (page ${spans[0]?.pageStart} to page ${spans[spans.length - 1]?.pageEnd}).`);
  } else if (multiLine) {
    notes.push("This quote spans more than one line in the document.");
  }
  const occurrences = alternatives.length + 1;
  const occurrenceCountIsCapped = occurrencePositions.length >= MAX_OCCURRENCES;
  if (occurrences > 1) {
    notes.push(
      `This wording appears ${occurrenceCountIsCapped ? `at least ${occurrences}` : occurrences} times; use the arrows to step through each occurrence.`,
    );
  }

  const normalizedLength = normalizeText(raw).text.length;
  const weakEvidence = normalizedLength < SHORT_QUOTE_CHARS;
  if (weakEvidence) {
    notes.push("Short quote: verified, but it is weak evidence on its own.");
  }

  return {
    ...base,
    status: "verified",
    method,
    spans,
    failedSegments: [],
    start,
    end,
    pageStart: spans[0]?.pageStart ?? null,
    pageEnd: spans[spans.length - 1]?.pageEnd ?? null,
    crossPage,
    multiLine,
    occurrences,
    alternatives,
    similarity: 1,
    closest: null,
    weakEvidence,
    notes,
  };
}
