/**
 * Lexical retrieval over chunks.
 *
 * BM25 rather than embeddings, for three reasons that are all about trust: it is
 * deterministic (so it can be tested and reasoned about), it needs no second
 * network call that can fail mid-question, and when it finds nothing it can say
 * so with a number rather than a vague similarity. An embedding model that
 * scores an unrelated clause at 0.78 would quietly invite the model to answer
 * from the wrong part of the contract.
 *
 * Legal text also rewards exact phrasing a lot, so a verbatim phrase from the
 * question is scored on top of BM25 — "liability cap" should find clause 11 even
 * if every word in it is common elsewhere.
 *
 * `noMatch` is the signal the agent uses to stop and say "the document does not
 * appear to cover this" instead of guessing. It is deliberately conservative:
 * a low score means "no lexical evidence", which is reported to the model as
 * such, and never as proof that a clause is absent.
 */

import type { Chunk } from "@/lib/text/chunk";
import { normalizeText } from "@/lib/text/normalize";

import { searchTerms, tokenize } from "./tokenize";

export type RankedChunk = {
  chunk: Chunk;
  score: number;
  matchedTerms: string[];
  phrase: string | null;
  /** Human-readable justification, shown in the "what the agent did" log. */
  reason: string;
};

export type SearchResult = {
  query: string;
  terms: string[];
  ranked: RankedChunk[];
  chunksSearched: number;
  topScore: number;
  /** Fraction of the question's meaningful terms that appear in the best passages. */
  coverage: number;
  noMatch: boolean;
  exactPhrase: string | null;
};

export type SearchOptions = {
  limit?: number;
  /** Below this BM25 score, retrieval reports no match rather than a weak one. */
  minScore?: number;
  /** Restrict to specific documents when several are in play. */
  documentIds?: string[];
};

const K1 = 1.2;
const B = 0.75;
const DEFAULT_LIMIT = 6;
const DEFAULT_MIN_SCORE = 1.6;
/**
 * Score alone is not enough to call something a match. A long question shares
 * *some* word with almost any contract, so a passage also has to cover a real
 * share of the question's meaningful terms. "How many shares are issued under
 * the employee equity plan?" scores 2.6 against a services agreement on the
 * strength of a single incidental word; it covers 0 of 8 terms, and that is the
 * signal that matters.
 */
const DEFAULT_MIN_COVERAGE = 0.3;

/** Longest n-gram from the question that appears verbatim in a chunk. */
function bestPhrase(terms: string[], normalizedChunk: string): { phrase: string; length: number } | null {
  const max = Math.min(terms.length, 7);
  for (let size = max; size >= 2; size -= 1) {
    for (let start = 0; start + size <= terms.length; start += 1) {
      const phrase = terms.slice(start, start + size).join(" ");
      if (normalizedChunk.includes(phrase)) return { phrase, length: size };
    }
  }
  return null;
}

export function searchChunks(query: string, chunks: Chunk[], options: SearchOptions = {}): SearchResult {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const candidates =
    options.documentIds && options.documentIds.length > 0
      ? chunks.filter((chunk) => options.documentIds?.includes(chunk.documentId))
      : chunks;

  const terms = searchTerms(query);
  const empty: SearchResult = {
    query,
    terms,
    ranked: [],
    chunksSearched: candidates.length,
    topScore: 0,
    coverage: 0,
    noMatch: true,
    exactPhrase: null,
  };
  if (candidates.length === 0 || terms.length === 0) return empty;

  const prepared = candidates.map((chunk) => {
    const normalized = normalizeText(chunk.text).text.toLowerCase();
    const counts = new Map<string, number>();
    let length = 0;
    for (const token of tokenize(chunk.text)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
      length += 1;
    }
    const headingCounts = new Map<string, number>();
    if (chunk.heading) {
      for (const token of tokenize(chunk.heading)) {
        headingCounts.set(token, (headingCounts.get(token) ?? 0) + 1);
      }
    }
    return { chunk, normalized, counts, headingCounts, length };
  });

  const averageLength =
    prepared.reduce((total, entry) => total + entry.length, 0) / Math.max(1, prepared.length);

  const documentFrequency = new Map<string, number>();
  for (const term of terms) {
    let frequency = 0;
    for (const entry of prepared) if (entry.counts.has(term)) frequency += 1;
    documentFrequency.set(term, frequency);
  }

  const scored: RankedChunk[] = [];
  for (const entry of prepared) {
    let score = 0;
    const matched: string[] = [];

    for (const term of terms) {
      const frequency = entry.counts.get(term) ?? 0;
      if (frequency === 0) {
        // Terms are only counted when present; a heading hit is evidence even
        // when the clause body never repeats the word.
        if (entry.headingCounts.has(term)) {
          score += 1.5;
          matched.push(term);
        }
        continue;
      }
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (prepared.length - df + 0.5) / (df + 0.5));
      const numerator = frequency * (K1 + 1);
      const denominator = frequency + K1 * (1 - B + (B * entry.length) / averageLength);
      score += idf * (numerator / denominator);
      if (!matched.includes(term)) matched.push(term);
    }

    const phrase = bestPhrase(terms, entry.normalized);
    if (phrase) score += 1.2 * phrase.length;

    if (score <= 0) continue;
    scored.push({
      chunk: entry.chunk,
      score: Number(score.toFixed(3)),
      matchedTerms: matched,
      phrase: phrase?.phrase ?? null,
      reason: phrase
        ? `verbatim phrase "${phrase.phrase}" plus ${matched.length} matching term${matched.length === 1 ? "" : "s"}`
        : `${matched.length} matching term${matched.length === 1 ? "" : "s"} (${matched.join(", ")})`,
    });
  }

  scored.sort((a, b) => b.score - a.score || a.chunk.start - b.chunk.start);
  const topScore = scored[0]?.score ?? 0;

  // A question's concepts can legitimately sit in different clauses, so coverage
  // is measured across the best few passages rather than one.
  const unionMatched = new Set<string>();
  for (const entry of scored.slice(0, 3)) {
    for (const term of entry.matchedTerms) unionMatched.add(term);
  }
  const coverage = terms.length === 0 ? 0 : unionMatched.size / terms.length;

  return {
    query,
    terms,
    ranked: scored.slice(0, limit),
    chunksSearched: candidates.length,
    topScore,
    coverage: Number(coverage.toFixed(3)),
    noMatch: topScore < minScore || coverage < DEFAULT_MIN_COVERAGE,
    exactPhrase: scored[0]?.phrase ?? null,
  };
}
