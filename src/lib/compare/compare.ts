/**
 * Comparing two versions of a contract.
 *
 * The brief is specific about what this must not be: a character diff. A
 * character diff of a reworded sentence produces noise, and it cannot tell a
 * reworded sentence from a liability cap moving from AED 100,000 to AED
 * 1,000,000 — which is exactly the distinction that matters.
 *
 * So comparison happens at clause level, in three steps:
 *
 *   align       match clauses across the versions by number, then by heading,
 *               then by similarity, so a renumbered clause is still recognised
 *               as the same clause rather than as one deletion plus one addition
 *   classify    added / removed / modified / reworded, using the token diff
 *   score       significance from what actually changed: amounts and obligation
 *               words are weighted far above prose. A phrasing change with the
 *               same numbers and the same obligations is reported as cosmetic,
 *               and how far that judgement can be pushed is stated in the README.
 */

import type { DocumentBundle } from "@/lib/storage/documents";
import { extractClauseOutline, type ClauseOutline } from "@/lib/text/chunk";
import { tokenize } from "@/lib/search/tokenize";

import {
  type DiffSegment,
  changedEntityTokens,
  diffTokens,
  extractModality,
  extractNamedEntities,
  extractQuantities,
  hasNegation,
  tokenSimilarity,
} from "./diff";

export type ChangeKind = "added" | "removed" | "modified" | "reworded";
export type Significance = "critical" | "high" | "medium" | "low";

export type ClauseVersion = {
  number: string | null;
  heading: string | null;
  text: string;
  start: number;
  end: number;
  pageStart: number | null;
  pageEnd: number | null;
};

export type ClauseChange = {
  id: string;
  kind: ChangeKind;
  significance: Significance;
  label: string;
  /** One line naming what actually changed, for the list view. */
  summary: string;
  /** Machine-checkable statements of change, e.g. "amounts: 100,000 -> 1,000,000". */
  signals: string[];
  similarity: number;
  left: ClauseVersion | null;
  right: ClauseVersion | null;
  segments: DiffSegment[];
  /** True when the clause body was too long for an exact diff. */
  coarse: boolean;
};

export type ComparisonResult = {
  left: { id: string; title: string; clauseCount: number };
  right: { id: string; title: string; clauseCount: number };
  changes: ClauseChange[];
  counts: Record<ChangeKind | Significance, number>;
  /** Clauses that matched across the two versions. */
  matched: number;
  ignoredNoise: number;
};

const CLAUSE_UNIT_SPLIT = /(?=^\s*\d+(?:\.\d+)*\.?\s)/m;

/**
 * Remove clause numbering from the body before comparing.
 *
 * Numbering is not content: without this, renumbering a clause reads as a
 * content change, and a sub-clause number like "12.4" is picked up as a quantity
 * and reported as an amount that changed. Applied to both versions, so the
 * comparison stays symmetric.
 */
function stripNumbering(text: string): string {
  return text.replace(/^[ \t]*\d+(?:\.\d+)*\.?[ \t]+/gm, "");
}

function clauseVersions(bundle: DocumentBundle): ClauseVersion[] {
  const outline: ClauseOutline[] = bundle.clauses.length > 0 ? bundle.clauses : extractClauseOutline(bundle.document);
  return outline
    .map((clause) => ({
      number: clause.number,
      heading: clause.heading,
      text: stripNumbering(bundle.document.text.slice(clause.start, clause.end).trim()),
      start: clause.start,
      end: clause.end,
      pageStart: clause.pageStart,
      pageEnd: clause.pageEnd,
    }))
    .filter((clause) => clause.text.length > 0);
}

function labelOf(clause: ClauseVersion | null): string {
  if (!clause) return "unknown clause";
  const number = clause.number ? `Clause ${clause.number}` : "Unnumbered clause";
  return clause.heading ? `${number} — ${clause.heading}` : number;
}

/** Headings that carry commercial weight when a clause appears or disappears. */
const HEAVY_HEADINGS = /liabil|indemn|termination|limitation|payment|fees|confidential|exclusiv|non-compete|non-solicit|warrant|intellectual property|governing law|jurisdiction|assignment|force majeure/i;

/** Match clauses across versions: by number, then heading, then content. */
function align(left: ClauseVersion[], right: ClauseVersion[]) {
  const pairs: Array<{ left: ClauseVersion | null; right: ClauseVersion | null }> = [];
  const usedRight = new Set<number>();

  const remainingLeft: ClauseVersion[] = [];

  // Pass 1: same clause number.
  for (const leftClause of left) {
    const index = right.findIndex(
      (candidate, position) =>
        !usedRight.has(position) && leftClause.number !== null && candidate.number === leftClause.number,
    );
    if (index === -1) {
      remainingLeft.push(leftClause);
      continue;
    }
    usedRight.add(index);
    pairs.push({ left: leftClause, right: right[index] ?? null });
  }

  // Pass 2: same heading (catches renumbered clauses).
  const stillLeft: ClauseVersion[] = [];
  for (const leftClause of remainingLeft) {
    const heading = leftClause.heading?.toLowerCase().trim();
    const index = heading
      ? right.findIndex(
          (candidate, position) =>
            !usedRight.has(position) && candidate.heading?.toLowerCase().trim() === heading,
        )
      : -1;
    if (index === -1) {
      stillLeft.push(leftClause);
      continue;
    }
    usedRight.add(index);
    pairs.push({ left: leftClause, right: right[index] ?? null });
  }

  // Pass 3: content similarity (handles a clause whose heading was also edited).
  const leftoverLeft: ClauseVersion[] = [];
  for (const leftClause of stillLeft) {
    let bestIndex = -1;
    let bestScore = 0;
    right.forEach((candidate, position) => {
      if (usedRight.has(position)) return;
      const score = tokenSimilarity(leftClause.text, candidate.text);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = position;
      }
    });
    if (bestIndex === -1 || bestScore < 0.45) {
      leftoverLeft.push(leftClause);
      continue;
    }
    usedRight.add(bestIndex);
    pairs.push({ left: leftClause, right: right[bestIndex] ?? null });
  }

  for (const leftClause of leftoverLeft) pairs.push({ left: leftClause, right: null });
  right.forEach((rightClause, position) => {
    if (!usedRight.has(position)) pairs.push({ left: null, right: rightClause });
  });

  return pairs;
}

/**
 * Describe a change in amounts readably: unchanged values are dropped first, and
 * the remainder is paired so the reader sees "AED 100,000 -> AED 1,000,000"
 * rather than two unrelated lists of numbers.
 */
function describeQuantityChange(before: string[], after: string[]): string {
  const remainingBefore = [...before];
  const remainingAfter: string[] = [];

  for (const value of after) {
    const index = remainingBefore.indexOf(value);
    if (index === -1) remainingAfter.push(value);
    else remainingBefore.splice(index, 1);
  }

  const parts: string[] = [];
  const pairs = Math.max(remainingBefore.length, remainingAfter.length);
  for (let index = 0; index < pairs; index += 1) {
    const from = remainingBefore[index];
    const to = remainingAfter[index];
    if (from && to) parts.push(`${from} → ${to}`);
    else if (to) parts.push(`added ${to}`);
    else if (from) parts.push(`removed ${from}`);
  }

  return parts.slice(0, 4).join(", ") || "values differ";
}

function numberMagnitude(values: string[]): number {
  const numbers = values
    .map((value) => Number.parseFloat(value.replace(/[^\d.]/g, "")))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (numbers.length === 0) return 1;
  return Math.max(...numbers) / Math.min(...numbers);
}

type Classification = {
  kind: ChangeKind;
  significance: Significance;
  summary: string;
  signals: string[];
};

function classifyPair(
  left: ClauseVersion | null,
  right: ClauseVersion | null,
  similarity: number,
): Classification {
  if (left && !right) {
    const heavy = left.heading ? HEAVY_HEADINGS.test(left.heading) : false;
    return {
      kind: "removed",
      significance: heavy ? "high" : "medium",
      summary: `The whole clause was removed${left.heading ? ` (${left.heading.toLowerCase()})` : ""}.`,
      signals: ["clause removed"],
    };
  }
  if (!left && right) {
    const heavy = right.heading ? HEAVY_HEADINGS.test(right.heading) : false;
    return {
      kind: "added",
      significance: heavy ? "high" : "medium",
      summary: `A new clause was added${right.heading ? ` (${right.heading.toLowerCase()})` : ""}.`,
      signals: ["clause added"],
    };
  }
  if (!left || !right) {
    return { kind: "modified", significance: "low", summary: "No comparable text.", signals: [] };
  }

  const leftQuantities = extractQuantities(left.text);
  const rightQuantities = extractQuantities(right.text);
  const leftModality = extractModality(left.text).join(" ");
  const rightModality = extractModality(right.text).join(" ");
  const entityChanges = changedEntityTokens(extractNamedEntities(left.text), extractNamedEntities(right.text));
  const signals: string[] = [];

  const quantitiesChanged = leftQuantities.slice().sort().join("|") !== rightQuantities.slice().sort().join("|");
  const modalityChanged = leftModality !== rightModality;
  const negationChanged = hasNegation(left.text) !== hasNegation(right.text);
  const entitiesChanged = entityChanges.added.length > 0 || entityChanges.removed.length > 0;

  if (quantitiesChanged) {
    signals.push(`amounts and periods changed: ${describeQuantityChange(leftQuantities, rightQuantities)}`);
  }
  if (negationChanged) signals.push("a negative obligation was added or removed");
  if (modalityChanged) signals.push("the obligation wording changed (for example shall/may/must)");
  if (entitiesChanged) {
    const parts = [
      entityChanges.removed.length > 0 ? `was ${entityChanges.removed.slice(0, 3).join(", ")}` : null,
      entityChanges.added.length > 0 ? `now ${entityChanges.added.slice(0, 3).join(", ")}` : null,
    ].filter(Boolean);
    signals.push(`named parties or places changed: ${parts.join("; ")}`);
  }

  const magnitude = numberMagnitude([...leftQuantities, ...rightQuantities]);
  const wordingOnly = !quantitiesChanged && !modalityChanged && !negationChanged && !entitiesChanged;

  if (wordingOnly && similarity >= 0.55) {
    return {
      kind: "reworded",
      significance: "low",
      summary: "Reworded, with the same amounts and the same obligations — no clear change in legal effect.",
      signals: ["wording only", `token similarity ${(similarity * 100).toFixed(0)}%`],
    };
  }

  if (quantitiesChanged && (negationChanged || magnitude >= 5)) {
    return {
      kind: "modified",
      significance: "critical",
      summary: `${signals[0] ?? "Amounts changed"}.`,
      signals,
    };
  }

  if (quantitiesChanged || negationChanged) {
    return {
      kind: "modified",
      significance: "high",
      summary: `${signals[0] ?? "Substantive wording changed"}.`,
      signals,
    };
  }

  if (modalityChanged || entitiesChanged) {
    return {
      kind: "modified",
      significance: "high",
      summary: modalityChanged
        ? "The obligation wording changed, which shifts what a party must do."
        : "A named party, place or forum changed.",
      signals,
    };
  }

  if (similarity >= 0.4) {
    return {
      kind: "modified",
      significance: "low",
      summary: "Wording changed substantially, but no amounts, obligations or negatives were affected.",
      signals: [`token similarity ${(similarity * 100).toFixed(0)}%`],
    };
  }

  return {
    kind: "modified",
    significance: "medium",
    summary: "Most of the clause was rewritten.",
    signals: [`token similarity ${(similarity * 100).toFixed(0)}%`],
  };
}

export function compareDocuments(left: DocumentBundle, right: DocumentBundle): ComparisonResult {
  const leftClauses = clauseVersions(left);
  const rightClauses = clauseVersions(right);
  const pairs = align(leftClauses, rightClauses);

  const changes: ClauseChange[] = pairs.map((pair, index) => {
    const similarity =
      pair.left && pair.right ? tokenSimilarity(pair.left.text, pair.right.text) : pair.left || pair.right ? 0 : 1;
    const diff = pair.left && pair.right ? diffTokens(pair.left.text, pair.right.text) : null;
    const classification = classifyPair(pair.left, pair.right, similarity);

    return {
      id: `chg-${index + 1}`,
      kind: classification.kind,
      significance: classification.significance,
      label: labelOf(pair.left ?? pair.right),
      summary: classification.summary,
      signals: classification.signals,
      similarity,
      left: pair.left,
      right: pair.right,
      segments: diff?.segments ?? [],
      coarse: (pair.left?.text.length ?? 0) + (pair.right?.text.length ?? 0) > 12_000,
    };
  });

  // Sort by significance first so the important changes are never buried, then
  // by position so a reader can still follow the document order within a level.
  const rank: Record<Significance, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  changes.sort((a, b) => rank[a.significance] - rank[b.significance] || (a.left?.start ?? 0) - (b.left?.start ?? 0));

  const counts = {
    added: changes.filter((change) => change.kind === "added").length,
    removed: changes.filter((change) => change.kind === "removed").length,
    modified: changes.filter((change) => change.kind === "modified").length,
    reworded: changes.filter((change) => change.kind === "reworded").length,
    critical: changes.filter((change) => change.significance === "critical").length,
    high: changes.filter((change) => change.significance === "high").length,
    medium: changes.filter((change) => change.significance === "medium").length,
    low: changes.filter((change) => change.significance === "low").length,
  };

  const ignoredNoise = changes.filter(
    (change) => change.kind === "reworded" || (change.kind === "modified" && change.significance === "low"),
  ).length;

  return {
    left: { id: left.record.id, title: left.record.title, clauseCount: leftClauses.length },
    right: { id: right.record.id, title: right.record.title, clauseCount: rightClauses.length },
    changes,
    counts,
    matched: changes.filter((change) => change.left && change.right).length,
    ignoredNoise,
  };
}

export function formatChangeForSummary(change: ClauseChange): {
  kind: ChangeKind;
  significance: Significance;
  label: string;
  summary: string;
  signals: string[];
  changedTokens: number;
  totalTokens: number;
} {
  const totalTokens = tokenize(`${change.left?.text ?? ""} ${change.right?.text ?? ""}`).length;
  const changedTokens = tokenize(
    change.segments
      .filter((segment) => segment.type !== "same")
      .map((segment) => segment.text)
      .join(" "),
  ).length;
  return {
    kind: change.kind,
    significance: change.significance,
    label: change.label,
    summary: change.summary,
    signals: change.signals,
    changedTokens,
    totalTokens,
  };
}

export { CLAUSE_UNIT_SPLIT };
