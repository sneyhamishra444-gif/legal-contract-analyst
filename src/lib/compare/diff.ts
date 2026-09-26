/**
 * Diffing primitives for document comparison.
 *
 * Two levels are needed and they answer different questions:
 *
 *   similarity  "is this the same clause, reworded, or a different clause?"
 *               — token-set overlap, order-insensitive and cheap.
 *   word diff   "what exactly changed in it?" — an LCS walk over tokens, which
 *               is order-sensitive, for the side-by-side highlight.
 *
 * Paragraph-level rather than character-level comparison is the requirement, so
 * everything here works on whole clauses or paragraphs, and the output is
 * grouped as "these words were added, these were removed" inside a matched pair.
 */

import { tokenize } from "@/lib/search/tokenize";

export type DiffSegment = {
  type: "same" | "added" | "removed";
  text: string;
};

export type TokenDiff = {
  segments: DiffSegment[];
  addedTokens: number;
  removedTokens: number;
  /** 0..1, share of tokens unchanged. */
  similarity: number;
};

/** Dice coefficient over token multisets — order-insensitive. */
export function tokenSimilarity(left: string, right: string): number {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (leftTokens.length === 0 && rightTokens.length === 0) return 1;
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;

  const leftCounts = new Map<string, number>();
  for (const token of leftTokens) leftCounts.set(token, (leftCounts.get(token) ?? 0) + 1);
  const rightCounts = new Map<string, number>();
  for (const token of rightTokens) rightCounts.set(token, (rightCounts.get(token) ?? 0) + 1);

  let shared = 0;
  for (const [token, count] of leftCounts) shared += Math.min(count, rightCounts.get(token) ?? 0);
  return (2 * shared) / (leftTokens.length + rightTokens.length);
}

const MAX_LCS_TOKENS = 2500;

/**
 * Token-level LCS diff.
 *
 * Above a token budget the LCS table is abandoned for a coarse positional
 * comparison: still a correct diff in the sense that it never claims unchanged
 * text changed, but less precise. A clause that long is a data dump, not a
 * clause, and the interface says the comparison is coarse when this happens.
 */
export function diffTokens(before: string, after: string): TokenDiff {
  const beforeTokens = wordsWithSpacing(before);
  const afterTokens = wordsWithSpacing(after);

  if (beforeTokens.length > MAX_LCS_TOKENS || afterTokens.length > MAX_LCS_TOKENS) {
    return coarseDiff(beforeTokens, afterTokens);
  }

  // Classic LCS dynamic programming over tokens.
  const n = beforeTokens.length;
  const m = afterTokens.length;
  const table: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));

  for (let i = n - 1; i >= 0; i -= 1) {
    const row = table[i];
    const next = table[i + 1];
    if (!row || !next) continue;
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] =
        beforeTokens[i]?.toLowerCase() === afterTokens[j]?.toLowerCase()
          ? (next[j + 1] ?? 0) + 1
          : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const segments: DiffSegment[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;

  const push = (type: DiffSegment["type"], text: string) => {
    if (!text) return;
    const last = segments[segments.length - 1];
    if (last && last.type === type) last.text += text;
    else segments.push({ type, text });
  };

  while (i < n && j < m) {
    const left = beforeTokens[i];
    const right = afterTokens[j];
    if (left !== undefined && right !== undefined && left.toLowerCase() === right.toLowerCase()) {
      push("same", joinWithSpacing(left, segments));
      i += 1;
      j += 1;
      continue;
    }
    const down = table[i + 1]?.[j] ?? 0;
    const rightScore = table[i]?.[j + 1] ?? 0;
    if (down >= rightScore) {
      push("removed", appendSpace(left));
      removed += 1;
      i += 1;
    } else {
      push("added", appendSpace(right));
      added += 1;
      j += 1;
    }
  }
  while (i < n) {
    push("removed", appendSpace(beforeTokens[i]));
    removed += 1;
    i += 1;
  }
  while (j < m) {
    push("added", appendSpace(afterTokens[j]));
    added += 1;
    j += 1;
  }

  const total = Math.max(1, beforeTokens.length + afterTokens.length);
  return {
    segments,
    addedTokens: added,
    removedTokens: removed,
    similarity: Number((1 - (added + removed) / total).toFixed(3)),
  };
}

/** Tokens carrying their following space, so re-joining the diff reproduces text. */
function wordsWithSpacing(text: string): string[] {
  return text.split(/(\s+)/).filter((piece) => piece.trim().length > 0).map((piece) => piece.trim());
}

function appendSpace(token: string | undefined): string {
  return token ? `${token} ` : "";
}

function joinWithSpacing(token: string, segments: DiffSegment[]): string {
  const previous = segments[segments.length - 1];
  if (!previous) return token;
  // Keep the original spacing after a removed run: it belongs to the old text.
  return previous.type === "same" ? `${token} ` : ` ${token} `;
}

function coarseDiff(beforeTokens: string[], afterTokens: string[]): TokenDiff {
  const beforeSet = new Map<string, number>();
  for (const token of beforeTokens) beforeSet.set(token.toLowerCase(), (beforeSet.get(token.toLowerCase()) ?? 0) + 1);
  const afterSet = new Map<string, number>();
  for (const token of afterTokens) afterSet.set(token.toLowerCase(), (afterSet.get(token.toLowerCase()) ?? 0) + 1);

  const segments: DiffSegment[] = [];
  let added = 0;
  let removed = 0;

  for (const token of beforeTokens) {
    const key = token.toLowerCase();
    const remaining = beforeSet.get(key) ?? 0;
    const match = afterSet.get(key) ?? 0;
    if (match > 0 && remaining > 0) {
      beforeSet.set(key, remaining - 1);
      afterSet.set(key, match - 1);
      segments.push({ type: "same", text: `${token} ` });
    } else {
      segments.push({ type: "removed", text: `${token} ` });
      removed += 1;
    }
  }
  for (const [key, count] of afterSet) {
    for (let index = 0; index < count; index += 1) {
      segments.push({ type: "added", text: `${key} ` });
      added += 1;
    }
  }

  const total = Math.max(1, beforeTokens.length + afterTokens.length);
  return {
    segments,
    addedTokens: added,
    removedTokens: removed,
    similarity: Number((1 - (added + removed) / total).toFixed(3)),
  };
}

/** Numbers and amounts, kept whole: "100,000", "AED 100,000", "60 days". */
export function extractQuantities(text: string): string[] {
  const quantities: string[] = [];
  // Contracts write amounts as "sixty (60) days", so a closing bracket between
  // the numeral and its unit must not hide the unit: "60 days" is the quantity,
  // not "60".
  const pattern =
    /(?:\(\s*)?(?:\b(?:aed|usd|eur|gbp|inr|dhs?)\s*)?\b\d[\d,]*(?:\.\d+)?\b\)?\s*(?:%|per cent|percent|days?|months?|years?|business days?)?/gi;
  for (const match of text.matchAll(pattern)) {
    const value = match[0]
      .replace(/[()]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (value.length > 0) quantities.push(value);
  }
  return quantities;
}

const MODALITY_PATTERN = /\b(shall not|shall|must not|must|may not|may|will not|will|agrees? to|is entitled to|is not entitled to|responsible for|not responsible for|liable|not liable)\b/gi;

/** Obligation words, which carry legal weight even when the amount of text is the same. */
export function extractModality(text: string): string[] {
  return [...text.matchAll(MODALITY_PATTERN)].map((match) => (match[0] ?? "").toLowerCase()).sort();
}

/**
 * Negation, including the wordings that hide it.
 *
 * The lexicon matters more than it looks: a first version only knew "not" and
 * "no", so a clause reworded from "nothing in this Agreement shall be construed
 * as creating..." to "no provision of this Agreement is intended to..." read as
 * a negation being added, and got reported as a substantive change when nothing
 * about it changed. "nothing", "cannot" and "without" belong in this list for the
 * same reason.
 */
export function hasNegation(text: string): boolean {
  return /\b(shall not|must not|may not|will not|cannot|can not|no |none|nothing|not |neither |nor |without |except |excluding )\b/i.test(
    text,
  );
}

/**
 * Named parties, places and instruments.
 *
 * Heuristic by necessity: without a named-entity model, the best available
 * signal is capitalisation, minus sentence-initial words. It exists because a
 * jurisdiction moving from "the courts of Dubai" to "the Dubai International
 * Financial Centre Courts" changes no number and no obligation word, so without
 * this the comparison would call it cosmetic — and it is not.
 */
const SENTENCE_START = /(?:^|[.!?]\s|\n\s*)$/;

const GENERIC_CONTRACT_WORDS = new Set([
  "agreement",
  "agreements",
  "party",
  "parties",
  "clause",
  "clauses",
  "schedule",
  "schedules",
  "section",
  "sections",
  "services",
  "service",
  "deliverable",
  "deliverables",
  "statement",
  "work",
  "effective",
  "date",
  "term",
  "annex",
  "appendix",
  "exhibit",
  "notwithstanding",
  "whereas",
  "including",
  "subject",
  "provided",
]);

export function extractNamedEntities(text: string): string[] {
  const entities = new Set<string>();
  const pattern = /\b[A-Z][a-zA-Z]{2,}(?:\s+(?:of|the|and)?\s*[A-Z][a-zA-Z]{2,})*/g;

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    const prefix = text.slice(0, index);
    if (SENTENCE_START.test(prefix)) continue;
    const value = match[0].replace(/\s+/g, " ").trim().toLowerCase();
    const words = value.split(" ");
    if (words.every((word) => GENERIC_CONTRACT_WORDS.has(word))) continue;
    entities.add(value);
  }

  return [...entities].sort();
}

/** Entity tokens that appeared on one side only, ignoring generic contract vocabulary. */
export function changedEntityTokens(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const beforeTokens = new Set(before.flatMap((entity) => entity.split(" ")));
  const afterTokens = new Set(after.flatMap((entity) => entity.split(" ")));
  const added = [...afterTokens].filter((token) => !beforeTokens.has(token) && !GENERIC_CONTRACT_WORDS.has(token));
  const removed = [...beforeTokens].filter((token) => !afterTokens.has(token) && !GENERIC_CONTRACT_WORDS.has(token));
  return { added: added.sort(), removed: removed.sort() };
}
