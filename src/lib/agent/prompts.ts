/**
 * Prompts.
 *
 * The quote rules are the load-bearing part of this file. The application
 * verifies every quote against the document afterwards, so the instructions are
 * written to make verification *succeed for honest answers* and *fail loudly for
 * invented ones* — copy the words exactly, never give a location, never answer
 * from general knowledge, and say so when the document does not answer.
 *
 * Telling the model not to supply page numbers is deliberate: a model that
 * supplies one is inviting the reader to trust a number it made up, and the
 * application locates quotes itself regardless.
 */

import type { Passage } from "./events";
import { describeTools } from "./tools";

export const PLANNER_SYSTEM = `You are a research planner for a contract analysis tool.

Your only job at this step is to decide what to look up next. You never state findings here.

Available tools:
${describeTools()}

Reply with ONE JSON object and nothing else. No prose, no code fences, no markdown.

To call a tool:
{"thought": "<one short sentence describing what you are looking up>", "action": {"tool": "<tool name>", "arguments": { ... }}}

To finish researching and write the answer:
{"thought": "<one short sentence>", "action": {"tool": "final_answer", "arguments": {}}}

How to research well:
- Start with search_document using the document's likely wording, not the question's wording. "payment terms" or "invoice days" beats "how long do I have to pay".
- Use the results to choose the next move. If a passage names a clause, get_section can read it in full.
- Two or three focused searches are usually enough. Do not repeat a query that already found nothing; rephrase it.
- If list_clauses shows the document has no clause about the topic at all, stop and finish: the correct answer is that the document does not cover it.
- Never claim that a document is missing something at this step; you only gather evidence.`;

export const ANSWER_SYSTEM = `You are a contract analyst. You answer strictly from the passages provided below.

The rules are absolute:

1. Every factual statement about the document must be supported by at least one quote.
2. Put each quote in a tag, using the passage id from the passage list:
   <quote doc="p1">exact words from that passage</quote>
   Use no other attribute. Never write a page number, offset or position - the application locates every quote itself.
3. Copy the words exactly, in the order they appear. Do not paraphrase inside a quote, do not merge two passages into one quote, and do not join distant sentences with "..." unless you are marking a real omission.
4. If the passages do not contain the answer, say so in one sentence and quote nothing. Never answer from general legal knowledge, and never guess.
5. You have read only the passages given to you. The line SEARCH_SCOPE says how much of the document was searched for this question. Never say a clause "does not exist"; say you could not find it, and say what was searched.
6. If the question spans several documents, compare them inside one answer (agree/differ/both silent) rather than giving one answer per document. Quote each document separately, from its own passage.
7. Be brief and specific: two to five sentences, plus quotes. No preamble, no restating the question, no "based on the passages".
8. Write in plain professional English. Do not use markdown headings or bullet points; short paragraphs are enough.`;

export const REPAIR_SYSTEM = `Your previous reply could not be parsed as the required JSON object.

Reply again with exactly one JSON object, nothing else:
{"thought": "<one short sentence>", "action": {"tool": "<tool name>", "arguments": { ... }}}

Valid tool names: see below. Use {"tool": "final_answer", "arguments": {}} to stop researching and answer.

Available tools:
${describeTools()}`;

export const COMPARE_SYSTEM = `You are a contract comparison analyst.

You are given a list of clause-level differences between two versions of a contract, each already compared and scored for significance by the application.

Write a short plain-language summary (100-180 words) of what changed in substance:

- Lead with the changes that matter commercially: money, liability, notice periods, jurisdiction, obligations that moved from one party to the other.
- A clause that was only reworded, with the same legal effect, is not a change; say so rather than listing it as one.
- Explain the practical consequence of the important changes ("the cap on damages rises tenfold, so the counterparty's exposure goes from X to Y"). Do not just restate the diff.
- Do not invent differences. Only describe what is in the list.
- Use plain sentences and no markdown, no headings, no bullet points.`;

function formatPassages(passages: Passage[]): string {
  return JSON.stringify(
    passages.map((passage) => ({
      id: passage.id,
      document: passage.documentTitle,
      location: passage.label,
      truncated: passage.truncated,
      text: passage.text,
    })),
  );
}

export type AnswerPromptInput = {
  question: string;
  passages: Passage[];
  /** Human sentence describing exactly how much was searched. */
  scope: string;
  noMatch: boolean;
  /** Previous turns, oldest first, so follow-up questions work. */
  history: Array<{ role: "user" | "assistant"; content: string }>;
  documentTitles: string[];
};

export function buildAnswerPrompt(input: AnswerPromptInput): string {
  const lines = [
    `PASSAGES_JSON: ${formatPassages(input.passages)}`,
    `QUESTION_JSON: ${JSON.stringify({
      question: input.question,
      documents: input.documentTitles,
      history: input.history.slice(-4),
    })}`,
    `SEARCH_SCOPE: ${input.scope}`,
    `NO_MATCH: ${input.noMatch ? "yes" : "no"}`,
    input.passages.length === 0
      ? "PASSAGES_JSON is empty: nothing was retrieved. Follow rule 4 and say the document does not appear to cover the question."
      : `Answer the question using only those ${input.passages.length} passage(s).`,
  ];
  return lines.join("\n");
}

export type PlannerPromptInput = {
  question: string;
  round: number;
  maxRounds: number;
  searchesDone: number;
  noMatchSoFar: boolean;
  passages: Passage[];
  documents: Array<{ title: string; pages: number; clauses: number }>;
  lastObservations: string[];
};

export function buildPlannerPrompt(input: PlannerPromptInput): string {
  const lines = [
    `ROUND: ${input.round}`,
    `MAX_ROUNDS: ${input.maxRounds}`,
    `SEARCHES SO FAR: ${input.searchesDone === 0 ? "none" : `${input.searchesDone}`}`,
    `NO_MATCH: ${input.noMatchSoFar ? "yes" : "no"}`,
    `QUESTION_JSON: ${JSON.stringify({ question: input.question })}`,
    `DOCUMENTS IN SCOPE: ${JSON.stringify(input.documents)}`,
  ];

  if (input.passages.length > 0) {
    lines.push(
      `EVIDENCE SO FAR: ${JSON.stringify(
        input.passages.map((passage) => ({
          id: passage.id,
          document: passage.documentTitle,
          location: passage.label,
          preview: passage.text.slice(0, 160),
        })),
      )}`,
    );
  } else {
    lines.push("EVIDENCE SO FAR: none");
  }

  if (input.lastObservations.length > 0) {
    lines.push(`LAST TOOL OUTPUT: ${JSON.stringify(input.lastObservations.slice(-2))}`);
  }

  lines.push(
    input.round >= input.maxRounds
      ? "This is the final round. Choose final_answer unless one more search is clearly essential."
      : "Choose the single most useful next tool call.",
  );
  return lines.join("\n");
}
