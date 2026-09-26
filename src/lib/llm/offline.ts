/**
 * The offline provider.
 *
 * This is not a mock. It is a real, deterministic answerer: it plans research
 * rounds, then answers by extracting verbatim sentences from the retrieved
 * passages and quoting them with the same `<quote>` markers a language model
 * uses — so the answer still travels through streaming and still has every quote
 * verified against the document. With no API key configured the app therefore
 * works end to end instead of showing an error, and it is honest about what it
 * is: the interface labels these answers "offline extractor", not "AI".
 *
 * It is also what makes the test suite deterministic. The agent loop, the
 * malformed-tool-call handling, the streaming protocol and the verifier are all
 * covered without mocking HTTP or paying for tokens.
 *
 * Its limits are real and worth stating: it extracts rather than reasons, it
 * cannot compare two clauses in prose, and it will not infer anything not
 * written down. When it has nothing, it says so.
 */

import { searchTerms } from "@/lib/search/tokenize";

import {
  type CompletionRequest,
  type LlmProvider,
  type StreamRequest,
} from "./provider";

/** Read a JSON value that follows a marker, scanning for balanced brackets. */
export function extractJsonValue<T>(text: string, marker: string): T | null {
  const start = text.indexOf(marker);
  if (start === -1) return null;
  const from = start + marker.length;
  const opening = text.slice(from).match(/[[{]/);
  if (!opening || opening.index === undefined) return null;

  const openChar = opening[0];
  const closeChar = openChar === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = from + opening.index; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === openChar) depth += 1;
    else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(from + opening.index, i + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

type PassageLike = {
  id: string;
  documentId?: string;
  label?: string;
  text: string;
};

type ChangeLike = {
  kind: string;
  significance: string;
  label: string;
  summary: string;
};

function readNumberField(text: string, field: string): number | null {
  const match = new RegExp(`${field}:\\s*(\\d+)`, "i").exec(text);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

function readStringField(text: string, field: string): string | null {
  const match = new RegExp(`${field}:\\s*(.+)`, "i").exec(text);
  return match?.[1]?.trim() ?? null;
}

/** Split a passage into sentences, keeping their offsets inside the passage. */
function sentencesOf(text: string): string[] {
  return (
    text
      .replace(/\n+/g, " ")
      .match(/[^.!?]*[.!?]+["'”’)\]]*|[^.!?]{25,}$/g)
      ?.map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 25) ?? []
  );
}

const WANTS_NUMBERS = /how much|how many|amount|cap|limit|maximum|minimum|period|days|percent|%|aed|usd|price|fee/i;

function scoreSentence(sentence: string, terms: string[]): number {
  const lower = sentence.toLowerCase();
  let score = 0;
  for (const term of terms) if (lower.includes(term)) score += 2;
  if (/\d/.test(sentence)) score += 1;
  if (/\b(shall|must|may not|entitled|liable|agrees? to|obligation)\b/i.test(sentence)) score += 0.5;
  // Prefer substantial sentences over headings and fragments.
  if (sentence.length > 80) score += 1;
  return score;
}

function pickEvidence(question: string, passages: PassageLike[]): Array<{ passage: PassageLike; sentences: string[] }> {
  const terms = searchTerms(question);
  const wantsNumbers = WANTS_NUMBERS.test(question);
  const scored: Array<{ passage: PassageLike; sentence: string; score: number }> = [];

  for (const passage of passages) {
    for (const sentence of sentencesOf(passage.text)) {
      let score = scoreSentence(sentence, terms);
      if (wantsNumbers && /\d/.test(sentence)) score += 2;
      if (score >= 3) scored.push({ passage, sentence, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const grouped = new Map<string, { passage: PassageLike; sentences: string[] }>();
  for (const entry of scored) {
    const bucket = grouped.get(entry.passage.id) ?? { passage: entry.passage, sentences: [] };
    if (bucket.sentences.length < 2 && !bucket.sentences.includes(entry.sentence)) {
      bucket.sentences.push(entry.sentence);
    }
    grouped.set(entry.passage.id, bucket);
    if (grouped.size >= 3) break;
  }

  return [...grouped.values()].filter((bucket) => bucket.sentences.length > 0).slice(0, 2);
}

function planRound(messages: CompletionRequest["messages"]): string {
  const lastUser = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const round = readNumberField(lastUser, "ROUND") ?? 1;
  const searches = readStringField(lastUser, "SEARCHES SO FAR") ?? "none";
  const question = extractJsonValue<{ question?: string }>(lastUser, "QUESTION_JSON:")?.question ?? "";
  const alreadySearched = searches.toLowerCase() !== "none" && searches.toLowerCase() !== "0";

  const terms = searchTerms(question);
  const fallbackQuery = question.replace(/\s+/g, " ").trim().slice(0, 120);

  if (round === 1 && !alreadySearched && terms.length > 0) {
    // First move: search on the most distinctive terms in the question. Names,
    // amounts and nouns carry the signal; the plumbing words are already gone.
    const focus = terms.filter((term) => term.length > 3).slice(0, 6);
    const query = (focus.length > 0 ? focus : terms).join(" ");
    return JSON.stringify({
      thought: `Searching the document for ${query}`,
      action: { tool: "search_document", arguments: { query } },
    });
  }

  if (round <= 2 && alreadySearched && terms.length > 2) {
    // Second move: a narrower query, in case the first phrasing does not appear
    // in the document's own words.
    const narrowed = terms.slice(0, 3).join(" ");
    return JSON.stringify({
      thought: `Trying a narrower search for ${narrowed}`,
      action: { tool: "search_document", arguments: { query: narrowed } },
    });
  }

  if (round === 1 && terms.length === 0) {
    return JSON.stringify({
      thought: "The question has no searchable terms.",
      action: { tool: "final_answer", arguments: {} },
    });
  }

  return JSON.stringify({
    thought: fallbackQuery ? "I have enough passages to answer." : "Nothing to search for.",
    action: { tool: "final_answer", arguments: {} },
  });
}

function composeAnswer(messages: CompletionRequest["messages"]): string[] {
  const lastUser = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const question = extractJsonValue<{ question?: string }>(lastUser, "QUESTION_JSON:")?.question ?? "";
  const passages = extractJsonValue<PassageLike[]>(lastUser, "PASSAGES_JSON:") ?? [];
  const scope = readStringField(lastUser, "SEARCH_SCOPE") ?? "";
  const noMatch = (readStringField(lastUser, "NO_MATCH") ?? "no").toLowerCase() === "yes";

  const lines: string[] = [];

  if (passages.length === 0 || noMatch) {
    lines.push(
      `I could not find anything in ${passages.length === 0 ? "the document" : "the searched passages"} that answers that. `,
    );
    lines.push(
      "Retrieval searched the whole document and found no passage matching those terms, so the honest answer is that this appears not to be covered — not that a clause is missing. ",
    );
    if (scope) lines.push(`Scope: ${scope}. `);
    lines.push(
      "If you expected it here, it may be in an annex, a schedule, or a definition that uses different wording. Try asking with the exact phrase you remember.",
    );
    return [lines.join("")];
  }

  const evidence = pickEvidence(question, passages);
  if (evidence.length === 0) {
    lines.push(
      "The document covers related ground but no sentence directly answers that question, so I will not invent one. ",
    );
    lines.push("Here is the closest wording the document actually contains, quoted verbatim");
    lines.push(` (${scope}).`);
    const fallback = passages[0];
    if (fallback) {
      const sentence = sentencesOf(fallback.text)[0];
      if (sentence) lines.push(`: <quote doc="${fallback.id}">${sentence}</quote>`);
    }
    return [lines.join("")];
  }

  const primary = evidence[0];
  if (primary) {
    const label = primary.passage.label ? `${primary.passage.label} of ` : "";
    lines.push(`${label}the document deals with this directly. `);
    for (const sentence of primary.sentences) {
      lines.push(`<quote doc="${primary.passage.id}">${sentence}</quote>`);
    }
  }

  const secondary = evidence[1];
  if (secondary && secondary.passage.id !== primary?.passage.id) {
    lines.push(` A related provision appears in ${secondary.passage.label ?? "another clause"}: `);
    const sentence = secondary.sentences[0];
    if (sentence) lines.push(`<quote doc="${secondary.passage.id}">${sentence}</quote>`);
  }

  lines.push(
    `\n\nThis answer is extracted verbatim from the document rather than written by a language model — no API key is configured, so nothing was paraphrased or inferred. Scope: ${scope || "the whole document was searched"}.`,
  );
  return [lines.join("")];
}

function composeChangeSummary(messages: CompletionRequest["messages"]): string {
  const lastUser = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const changes = extractJsonValue<ChangeLike[]>(lastUser, "CHANGES_JSON:") ?? [];
  if (changes.length === 0) return "No clause-level differences were found between these two versions.";

  const critical = changes.filter((change) => change.significance === "critical");
  const high = changes.filter((change) => change.significance === "high");
  const reworded = changes.filter((change) => change.kind === "reworded");

  const lines: string[] = [];
  lines.push(
    `${changes.length} clause-level difference${changes.length === 1 ? "" : "s"} were found: ${critical.length} critical, ${high.length} high, ${reworded.length} purely reworded. `,
  );
  if (critical.length > 0) {
    lines.push(`The substantive changes are: ${critical.slice(0, 3).map((change) => change.summary).join("; ")}. `);
  }
  if (high.length > 0) {
    lines.push(`Also worth attention: ${high.slice(0, 3).map((change) => change.summary).join("; ")}. `);
  }
  if (reworded.length > 0) {
    lines.push(
      `${reworded.length} clause${reworded.length === 1 ? " was" : "s were"} reworded without changing the legal effect, so they are listed separately. `,
    );
  }
  lines.push(
    "This summary is generated deterministically from detected differences because no API key is configured; the change list below is the authoritative record.",
  );
  return lines.join("");
}

async function* streamText(text: string): AsyncGenerator<string, void, unknown> {
  // Chunked so the interface's streaming path is exercised in offline mode too.
  const pieces = text.match(/[\s\S]{1,24}/g) ?? [];
  for (const piece of pieces) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    yield piece;
  }
}

export function createOfflineProvider(): LlmProvider {
  return {
    label: "offline deterministic extractor",
    model: "offline-extractor-v1",
    kind: "offline",
    available: true,

    async complete(request: CompletionRequest): Promise<string> {
      return planRound(request.messages);
    },

    async *stream(request: StreamRequest): AsyncGenerator<string, void, unknown> {
      const probe = request.messages.map((message) => message.content).join("\n");
      if (probe.includes("CHANGES_JSON:")) {
        yield* streamText(composeChangeSummary(request.messages));
        return;
      }
      const chunks = composeAnswer(request.messages);
      for (const chunk of chunks) yield* streamText(chunk);
    },
  };
}
