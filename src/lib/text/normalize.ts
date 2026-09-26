/**
 * Whitespace-tolerant normalisation, with an index map back to the original text.
 *
 * Why this exists
 * ---------------
 * Text pulled out of a PDF or DOCX almost never matches the text a model
 * "quotes" from it, even when the model is being honest. Line wrapping turns one
 * space into a newline, extraction inserts or removes spaces around glyphs,
 * curly quotes become straight ones in some readers and not others, and
 * non-breaking spaces hide in the middle of ordinary sentences.
 *
 * An exact `indexOf` therefore rejects quotes that genuinely *are* in the
 * document. The fix is to compare on a normalised form of both sides — but then
 * a match position means nothing in the original text, so the normalised string
 * carries a per-character map back to it. Every offset we report to the UI is
 * derived from that map, never from anything a model said.
 *
 * What normalisation is allowed to ignore: whitespace runs, invisible
 * characters, and typographic variants of the same character (curly vs straight
 * quotes, en/em dashes, ligatures, soft hyphens). What it is *not* allowed to
 * ignore: the words themselves. Nothing here reorders, removes or substitutes a
 * word, so a paraphrase still fails to match — which is the point.
 */

const DROPPED = new Set([
  0x00ad, // soft hyphen — invisible, and it splits words when copied
  0x200b, // zero width space
  0x200c, // zero width non-joiner
  0x200d, // zero width joiner
  0x2060, // word joiner
  0xfeff, // BOM / zero width no-break space
]);

/** Typographic variants mapped to the plain character a person would type. */
const SUBSTITUTIONS = new Map<number, string>([
  // Quotes and apostrophes
  [0x2018, "'"],
  [0x2019, "'"],
  [0x201a, "'"],
  [0x201b, "'"],
  [0x2039, "'"],
  [0x203a, "'"],
  [0x201c, '"'],
  [0x201d, '"'],
  [0x201e, '"'],
  [0x201f, '"'],
  [0x00ab, '"'],
  [0x00bb, '"'],
  // Dashes and minus signs
  [0x2010, "-"],
  [0x2011, "-"],
  [0x2012, "-"],
  [0x2013, "-"],
  [0x2014, "-"],
  [0x2015, "-"],
  [0x2212, "-"],
  // Primes
  [0x2032, "'"],
  [0x2033, '"'],
  // Ligatures expand to their letters
  [0xfb00, "ff"],
  [0xfb01, "fi"],
  [0xfb02, "fl"],
  [0xfb03, "ffi"],
  [0xfb04, "ffl"],
  [0xfb05, "st"],
  [0xfb06, "st"],
  // Ellipsis expands, so "…" and "..." normalise identically
  [0x2026, "..."],
]);

function isWhitespace(codePoint: number): boolean {
  return (
    codePoint === 0x20 ||
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0b ||
    codePoint === 0x0c ||
    codePoint === 0x0d ||
    codePoint === 0x00a0 || // non-breaking space
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) || // en quad .. hair space
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f || // narrow no-break space
    codePoint === 0x205f ||
    codePoint === 0x3000
  );
}

function isLetterOrDigit(codePoint: number): boolean {
  if (codePoint >= 0x30 && codePoint <= 0x39) return true; // 0-9
  if (codePoint >= 0x41 && codePoint <= 0x5a) return true; // A-Z
  if (codePoint >= 0x61 && codePoint <= 0x7a) return true; // a-z
  if (codePoint < 0x80) return false;
  return /[\p{L}\p{N}]/u.test(String.fromCodePoint(codePoint));
}

export type NormalizeOptions = {
  /**
   * Also treat a hyphen at a line break as joined: "indemnifi-\ncation"
   * becomes "indemnification". Off by default because it can only ever be a
   * guess — a genuine hyphen at a line end looks identical — so callers use it
   * as a second attempt after the plain form fails, and report which one hit.
   */
  joinLineBreakHyphens?: boolean;
};

export type NormalizedText = {
  /** The text as extracted, untouched. */
  original: string;
  /** Whitespace-collapsed, typographically folded. */
  text: string;
  /** `text` lowercased, guaranteed the same length, for case-insensitive search. */
  lower: string;
  /** index in `text` -> index in `original`. Always `map.length === text.length`. */
  map: Int32Array;
  options: NormalizeOptions;
};

/**
 * Lowercase without changing length.
 *
 * `String.prototype.toLowerCase` is not length-preserving for a handful of code
 * points (Turkish dotted capital I lowercases to two code points, for example).
 * Since the lowercase copy must stay index-aligned with `text`, those rare
 * characters are simply left as they are; a case difference on them is not
 * worth an offset bug.
 */
function lowerSameLength(value: string): string {
  let out = "";
  for (const char of value) {
    const lowered = char.toLowerCase();
    out += lowered.length === char.length ? lowered : char;
  }
  return out;
}

export function normalizeText(original: string, options: NormalizeOptions = {}): NormalizedText {
  const chars: string[] = [];
  const map: number[] = [];

  const emit = (value: string, sourceIndex: number) => {
    chars.push(value);
    for (let i = 0; i < value.length; i += 1) map.push(sourceIndex);
  };

  let pendingSpaceAt = -1;
  let suppressSpace = false;

  for (let i = 0; i < original.length; ) {
    const codePoint = original.codePointAt(i);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    const width = char.length;

    // Invisible formatting characters are removed outright. Dropping them can
    // never change which words are present, but leaving them in splits a word
    // in two: a soft hyphen copied out of a PDF turns "indemnification" into
    // something no quote can match.
    if (DROPPED.has(codePoint)) {
      i += width;
      continue;
    }

    if (isWhitespace(codePoint)) {
      if (!suppressSpace && pendingSpaceAt === -1 && chars.length > 0) pendingSpaceAt = i;
      i += width;
      continue;
    }

    // A hyphen followed (after any whitespace) by a letter/digit is a candidate
    // for line-break hyphenation. Only joined when asked to.
    if (
      options.joinLineBreakHyphens &&
      (codePoint === 0x2d || codePoint === 0x2010) &&
      chars.length > 0
    ) {
      let lookahead = i + width;
      while (lookahead < original.length) {
        const next = original.codePointAt(lookahead);
        if (next === undefined || !isWhitespace(next)) break;
        lookahead += String.fromCodePoint(next).length;
      }
      const afterBreak = original.codePointAt(lookahead);
      const beforeHyphen = i > 0 ? original.codePointAt(i - 1) : undefined;
      if (
        afterBreak !== undefined &&
        beforeHyphen !== undefined &&
        isLetterOrDigit(afterBreak) &&
        isLetterOrDigit(beforeHyphen)
      ) {
        // Drop the hyphen and swallow the following whitespace run.
        suppressSpace = true;
        i += width;
        continue;
      }
    }

    if (pendingSpaceAt !== -1) {
      emit(" ", pendingSpaceAt);
      pendingSpaceAt = -1;
    }
    suppressSpace = false;

    const substituted = SUBSTITUTIONS.get(codePoint);
    emit(substituted ?? char, i);
    i += width;
  }

  const text = chars.join("");
  return {
    original,
    text,
    lower: lowerSameLength(text),
    map: Int32Array.from(map),
    options,
  };
}

/** Translate a range in `normalized.text` back into offsets in the original text. */
export function toOriginalRange(
  normalized: NormalizedText,
  start: number,
  end: number,
): { start: number; end: number } {
  const { map, original, text } = normalized;
  if (text.length === 0) return { start: 0, end: 0 };

  const clamp = (value: number) => Math.max(0, Math.min(value, text.length));
  const from = clamp(start);
  const to = clamp(end);

  // `end` is exclusive, so the last covered character is `to - 1`.
  const lastIndex = to - 1;
  const originalStart = map[Math.min(from, map.length - 1)] ?? 0;
  const originalEnd =
    lastIndex >= 0 && lastIndex < map.length ? (map[lastIndex] ?? 0) + 1 : original.length;

  return { start: originalStart, end: Math.max(originalStart, originalEnd) };
}

/**
 * Rebuild the text a normalised range covers, using the original characters.
 * Line breaks in the document survive, which is what the reader should see when
 * a quote spans several lines.
 */
export function originalSlice(normalized: NormalizedText, start: number, end: number): string {
  const range = toOriginalRange(normalized, start, end);
  return normalized.original.slice(range.start, range.end);
}
