/**
 * One tokenizer, used by search and by document comparison, so "the same words"
 * means the same thing everywhere in the codebase.
 *
 * Two deliberate choices:
 *
 *  - Amounts stay whole. "AED 100,000" tokenises to `aed` + `100,000`, not
 *    `100` + `000`, because in a contract those digits are the clause.
 *  - Hyphenated compounds produce both the compound and its parts, so a search
 *    for "non-solicitation" matches text written as "non solicitation" and vice
 *    versa, without a stemmer that would also merge unrelated words.
 */

const TOKEN_PATTERN = /[\p{L}]+|\p{N}[\p{N},.]*\p{N}|\p{N}/gu;

/** Words that carry no discriminating power in a contract, or that are structural. */
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "but",
  "by",
  "can",
  "clause",
  "clauses",
  "do",
  "does",
  "for",
  "from",
  "has",
  "have",
  "herein",
  "hereof",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "may",
  "of",
  "on",
  "or",
  "our",
  "shall",
  "should",
  "so",
  "such",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "this",
  "those",
  "to",
  "under",
  "upon",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "will",
  "with",
  "would",
  "you",
  "your",
  // Question and instruction words. These are how a person asks, not what the
  // contract says, so matching on them is pure noise.
  "about",
  "after",
  "against",
  "all",
  "also",
  "among",
  "before",
  "between",
  "both",
  "could",
  "describe",
  "detail",
  "details",
  "discuss",
  "does",
  "doing",
  "during",
  "each",
  "either",
  "explain",
  "find",
  "get",
  "give",
  "has",
  "having",
  "how",
  "however",
  "kind",
  "know",
  "list",
  "made",
  "make",
  "many",
  "me",
  "might",
  "more",
  "most",
  "much",
  "must",
  "my",
  "need",
  "note",
  "now",
  "only",
  "other",
  "others",
  "over",
  "please",
  "provide",
  "same",
  "say",
  "says",
  "see",
  "show",
  "since",
  "some",
  "state",
  "summarise",
  "summarize",
  "tell",
  "therefore",
  "though",
  "through",
  "thus",
  "too",
  "unless",
  "until",
  "use",
  "used",
  "uses",
  "using",
  "very",
  "way",
  "well",
  "what",
  "whatever",
  "whenever",
  "where",
  "whereas",
  "whereby",
  "wherever",
  "whether",
  "why",
  "without",
  "yet",
]);

/**
 * Hyphenated compounds are indexed whole *and* in parts, so "non-solicitation"
 * also matches "non solicitation". Parts shorter than this are skipped: keeping
 * them turned the word "know-how" into a match for "how", which is exactly the
 * kind of phantom hit that makes retrieval look like it found something.
 */
const MIN_HYPHEN_PART_LENGTH = 4;

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const token of text.toLowerCase().match(TOKEN_PATTERN) ?? []) {
    tokens.push(token);
    if (token.includes("-")) {
      for (const part of token.split("-")) {
        if (part.length >= MIN_HYPHEN_PART_LENGTH) tokens.push(part);
      }
    }
  }
  return tokens;
}

/** Tokens that are worth matching on — stop words and single characters dropped. */
export function searchTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const token of tokenize(query)) {
    if (STOP_WORDS.has(token)) continue;
    if (token.length < 2 && !/\d/.test(token)) continue;
    terms.add(token);
  }
  return [...terms];
}

export function isStopWord(token: string): boolean {
  return STOP_WORDS.has(token);
}

export { STOP_WORDS };
