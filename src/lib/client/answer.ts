/**
 * Parsing an answer into prose and quotes.
 *
 * The server streams the answer exactly as the model wrote it, markers included,
 * and verifies each quote as it closes. This turns that text into renderable
 * segments: prose, completed quotes (which have a verification verdict attached
 * by the `quote` event with the same index), and a trailing quote still being
 * written — which is shown as "checking" rather than as either prose or a
 * finished quotation, because at that moment it is neither.
 *
 * Kept as a pure function so the streaming presentation can be tested without a
 * browser.
 */

export type AnswerSegment =
  | { kind: "text"; text: string }
  | { kind: "quote"; index: number; passageId: string; raw: string }
  | { kind: "quote-pending"; passageId: string; raw: string };

const COMPLETE_QUOTE = /<quote\s+doc\s*=\s*"([^"]*)"\s*>([\s\S]*?)<\/quote>/gi;
const OPEN_QUOTE = /<quote\s+doc\s*=\s*"([^"]*)"\s*>([\s\S]*)$/i;
const STRAY_MARKER = /<\/?quote[^>]*>/gi;

export function parseAnswer(content: string): AnswerSegment[] {
  const segments: AnswerSegment[] = [];
  let cursor = 0;
  let index = 0;

  for (const match of content.matchAll(COMPLETE_QUOTE)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      const text = content.slice(cursor, start);
      if (text.trim()) segments.push({ kind: "text", text });
    }
    segments.push({
      kind: "quote",
      index,
      passageId: match[1] ?? "",
      raw: (match[2] ?? "").trim(),
    });
    index += 1;
    cursor = start + match[0].length;
  }

  const tail = content.slice(cursor);
  if (!tail) return segments;

  const open = OPEN_QUOTE.exec(tail);
  if (open && open.index !== undefined) {
    const before = tail.slice(0, open.index);
    if (before.trim()) segments.push({ kind: "text", text: before });
    segments.push({ kind: "quote-pending", passageId: open[1] ?? "", raw: (open[2] ?? "").trim() });
    return segments;
  }

  const cleaned = tail.replace(STRAY_MARKER, "");
  if (cleaned.trim()) segments.push({ kind: "text", text: cleaned });
  return segments;
}

export function countCompleteQuotes(content: string): number {
  return parseAnswer(content).filter((segment) => segment.kind === "quote").length;
}
