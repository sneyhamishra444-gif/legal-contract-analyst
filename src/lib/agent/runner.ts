/**
 * The agent loop (Part C, option 2) and the streaming answer.
 *
 * The model never sees the document. It decides which tools to call, reads the
 * results, and calls more — and the whole trace is streamed to the browser so
 * the user watches it search instead of watching a spinner.
 *
 * Everything that can go wrong is bounded:
 *
 *   rounds        hard cap (AGENT_MAX_ROUNDS, clamped to 2..10). Hitting it is
 *                 reported as truncation, not hidden.
 *   tool calls    a total cap as well as a round cap, so one round cannot fan
 *                 out into unlimited calls.
 *   time          a wall-clock budget (AGENT_BUDGET_MS) on top of the round cap,
 *                 because a hosting platform enforces its own request deadline.
 *                 A budget produces a shorter answer that says it was cut short;
 *                 without one the platform kills the stream and nothing is saved.
 *   malformed     an invented tool name, missing arguments, a nonsense argument
 *                 or unparseable JSON is answered with a message describing the
 *                 correct shape. One JSON parse failure triggers a single repair
 *                 attempt; two consecutive malformed calls end research and the
 *                 answer is written from whatever evidence exists, flagged.
 *   no evidence   a question the documents do not cover produces an abstention,
 *                 never an answer from general knowledge.
 *   truncation    a stopped or failed stream keeps what was generated, and the
 *                 message is saved with status "stopped" or "error" rather than
 *                 being silently presented as complete.
 */

import { getProvider } from "@/lib/llm";
import { readAgentBudgetMs, readAgentMaxRounds } from "@/lib/llm/config";
import {
  LlmError,
  type ChatTurn,
  type LlmProvider,
  extractAction,
  parseJsonObject,
} from "@/lib/llm/provider";
import type { DocumentBundle } from "@/lib/storage/documents";
import { type QuoteVerification, verifyQuote } from "@/lib/text/verify";
import type { AgentStep, ChatMessageStatus, CoverageReport } from "@/lib/types";

import { type Passage, type StreamEvent } from "./events";
import { ANSWER_SYSTEM, PLANNER_SYSTEM, REPAIR_SYSTEM, buildAnswerPrompt, buildPlannerPrompt } from "./prompts";
import { FINAL_ANSWER_TOOL, type ToolContext, type ToolResult, findTool, toolNames } from "./tools";

export type RunAgentInput = {
  bundles: DocumentBundle[];
  question: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  conversationId: string;
  messageId: string;
  signal?: AbortSignal;
  /** Injectable for tests. */
  provider?: LlmProvider;
  maxRounds?: number;
  /** Whole-run wall-clock budget in milliseconds. Injectable for tests. */
  budgetMs?: number;
};

const TOTAL_TOOL_CALL_BUDGET = 8;
const MAX_CONSECUTIVE_MALFORMED = 2;

/**
 * How much of the run's time is held back for writing the answer.
 *
 * Research and answering draw on the same budget, and an answer that never gets
 * written is worth nothing, so research is stopped this far before the deadline
 * rather than being allowed to spend all of it searching.
 */
const ANSWER_ALLOWANCE_MS = 18_000;

/**
 * The caller's abort signal plus a deadline.
 *
 * Every provider call gets one, so no single slow request can consume the whole
 * budget and leave the run with no time to answer.
 */
function withDeadline(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, ms));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function step(kind: AgentStep["kind"], title: string, detail?: string, round?: number): AgentStep {
  return {
    id: crypto.randomUUID(),
    kind,
    title,
    detail,
    at: new Date().toISOString(),
    round,
  };
}

/** Every completed `<quote doc="pN">…</quote>` in the text so far. */
function findCompletedQuotes(text: string): RegExpMatchArray[] {
  return [...text.matchAll(/<quote\s+doc\s*=\s*"([^"]*)"\s*>([\s\S]*?)<\/quote>/gi)];
}

export async function* runAgent(input: RunAgentInput): AsyncGenerator<StreamEvent, void, unknown> {
  const provider = input.provider ?? getProvider();
  const maxRounds = input.maxRounds ?? readAgentMaxRounds();
  const warnings: string[] = [];

  // Two deadlines from one budget: research must stop at the first so the answer
  // can be written and saved before the second, which is the hard stop.
  const startedAt = Date.now();
  const totalBudgetMs = input.budgetMs ?? readAgentBudgetMs();
  const researchDeadline = startedAt + Math.max(0, totalBudgetMs - ANSWER_ALLOWANCE_MS);
  const hardDeadline = startedAt + totalBudgetMs;
  const researchTimeLeft = (): number => researchDeadline - Date.now();
  let truncationReported = false;

  const context: ToolContext = {
    bundles: input.bundles,
    passages: [],
    chunksInScope: input.bundles.reduce((total, bundle) => total + bundle.chunks.length, 0),
    nextPassageNumber: () => context.passages.length + 1,
  };

  yield {
    type: "start",
    conversationId: input.conversationId,
    messageId: input.messageId,
    provider: provider.kind,
    model: provider.model,
    maxRounds,
    documents: input.bundles.map((bundle) => ({
      id: bundle.record.id,
      title: bundle.record.title,
      pages: bundle.record.pageCount,
      clauses: bundle.chunks.length,
    })),
  };

  if (!provider.available) {
    warnings.push("No API key is configured, so the offline extractor answered instead of a language model.");
  }

  let searchesDone = 0;
  let rounds = 0;
  let truncated = false;
  let plannerFailed = false;
  let malformedStreak = 0;
  let totalToolCalls = 0;
  const observations: string[] = [];
  const documentsForPrompt = input.bundles.map((bundle) => ({
    title: bundle.record.title,
    pages: bundle.record.pageCount,
    clauses: bundle.chunks.length,
  }));

  let finalAnswerRequested = false;

  while (rounds < maxRounds && totalToolCalls < TOTAL_TOOL_CALL_BUDGET && !finalAnswerRequested) {
    // Checked before the round starts, so a round is never begun that cannot
    // finish inside the research window.
    if (researchTimeLeft() <= 0) break;
    rounds += 1;
    if (input.signal?.aborted) break;

    const plannerPrompt = buildPlannerPrompt({
      question: input.question,
      round: rounds,
      maxRounds,
      searchesDone,
      noMatchSoFar: context.passages.length === 0 && searchesDone > 0,
      passages: context.passages,
      documents: documentsForPrompt,
      lastObservations: observations,
    });

    let raw = "";
    try {
      raw = await provider.complete({
        messages: [
          { role: "system", content: PLANNER_SYSTEM },
          { role: "user", content: plannerPrompt },
        ],
        json: true,
        temperature: 0,
        signal: withDeadline(input.signal, researchTimeLeft()),
      });
    } catch (error) {
      if (input.signal?.aborted) break;
      // A planner call cut off by the deadline is not a provider failure; the
      // time limit is reported below instead of blaming the provider.
      if (researchTimeLeft() <= 0) break;
      plannerFailed = true;
      warnings.push(
        error instanceof LlmError
          ? `The model provider could not be reached for planning: ${error.message}`
          : "Planning failed before any research was done.",
      );
      yield { type: "warning", message: warnings[warnings.length - 1] ?? "Planning failed." };
      break;
    }

    let parsed = parseJsonObject(raw);
    if (!parsed) {
      // One repair attempt, then move on rather than looping on a model that
      // will not produce the required shape.
      yield {
        type: "step",
        step: step("note", "The plan was not valid JSON; asking for a corrected plan", undefined, rounds),
      };
      try {
        raw = await provider.complete({
          messages: [
            { role: "system", content: REPAIR_SYSTEM },
            { role: "user", content: `Your previous reply was:\n${raw.slice(0, 600)}\n\nReply again with one JSON object only.` },
          ],
          json: true,
          temperature: 0,
          signal: withDeadline(input.signal, researchTimeLeft()),
        });
        parsed = parseJsonObject(raw);
      } catch {
        parsed = null;
      }
      if (!parsed) {
        malformedStreak += 1;
        plannerFailed = true;
        warnings.push("The model did not return a usable plan, so research stopped early.");
        yield { type: "warning", message: warnings[warnings.length - 1] ?? "Planning failed." };
        break;
      }
    }

    const action = extractAction(parsed);
    const thought = typeof parsed.thought === "string" ? parsed.thought.trim() : "";

    if (!action) {
      malformedStreak += 1;
      yield {
        type: "step",
        step: step(
          "note",
          "The plan had no tool call",
          `Expected {"action": {"tool": "…", "arguments": {…}}}. Received: ${raw.slice(0, 160)}`,
          rounds,
        ),
      };
      if (malformedStreak >= MAX_CONSECUTIVE_MALFORMED) {
        warnings.push("The model repeatedly returned malformed tool calls, so research stopped early.");
        yield { type: "warning", message: warnings[warnings.length - 1] ?? "Malformed tool calls." };
        break;
      }
      continue;
    }

    if (action.tool === FINAL_ANSWER_TOOL) {
      yield { type: "step", step: step("decision", thought || "Enough evidence; writing the answer now", undefined, rounds) };
      finalAnswerRequested = true;
      break;
    }

    const tool = findTool(action.tool);
    if (!tool) {
      malformedStreak += 1;
      const message = `There is no tool named "${action.tool}". Available tools: ${toolNames().join(", ")}.`;
      observations.push(message);
      yield { type: "step", step: step("note", `Rejected an invented tool call: ${action.tool}`, message, rounds) };
      if (malformedStreak >= MAX_CONSECUTIVE_MALFORMED) {
        warnings.push("The model invented tool names repeatedly, so research stopped early.");
        yield { type: "warning", message: warnings[warnings.length - 1] ?? "Invented tool calls." };
        break;
      }
      continue;
    }

    // The model's stated intention is what makes the live log readable.
    yield { type: "step", step: step("tool", thought || `Using ${action.tool}`, `${action.tool}(${JSON.stringify(action.args ?? {})})`, rounds) };

    let result: ToolResult;
    try {
      result = await tool.run(action.args, context);
      totalToolCalls += 1;
    } catch (error) {
      // A tool must never take the request down with it.
      result = {
        ok: false,
        summary: `${action.tool} failed`,
        error: error instanceof Error ? error.message : "unknown error",
      };
      warnings.push(`The ${action.tool} tool failed on one call; the answer uses the evidence that was gathered.`);
    }

    if (action.tool === "search_document") searchesDone += 1;

    if (!result.ok) {
      malformedStreak += 1;
      observations.push(result.error ?? result.summary);
      yield { type: "step", step: step("note", result.summary, result.error, rounds) };
      if (malformedStreak >= MAX_CONSECUTIVE_MALFORMED) {
        warnings.push("Tool arguments were rejected twice in a row, so research stopped early.");
        yield { type: "warning", message: warnings[warnings.length - 1] ?? "Rejected tool arguments." };
        break;
      }
      continue;
    }

    malformedStreak = 0;
    observations.push(`${action.tool}: ${result.summary}`);
    yield {
      type: "step",
      step: step("result", result.summary, summarizeToolData(result), rounds),
    };
  }

  if (rounds >= maxRounds && !finalAnswerRequested) {
    truncated = true;
    truncationReported = true;
    warnings.push(`Research stopped at the round limit of ${maxRounds}; the answer uses the evidence gathered so far.`);
    yield { type: "warning", message: warnings[warnings.length - 1] ?? "Round limit reached." };
  }
  if (totalToolCalls >= TOTAL_TOOL_CALL_BUDGET && !finalAnswerRequested) {
    truncated = true;
    truncationReported = true;
    warnings.push(`Research stopped at the tool-call limit of ${TOTAL_TOOL_CALL_BUDGET}.`);
    yield { type: "warning", message: warnings[warnings.length - 1] ?? "Tool-call limit reached." };
  }
  // Whichever way the loop ended, running out of time means research was cut
  // short, and the answer must not sound as though it read everything.
  if (!finalAnswerRequested && researchTimeLeft() <= 0) {
    truncated = true;
    if (!truncationReported) {
      truncationReported = true;
      warnings.push(
        `Research stopped at the time limit for one answer (${Math.round(totalBudgetMs / 1000)}s); the answer below uses the evidence gathered so far.`,
      );
      yield { type: "warning", message: warnings[warnings.length - 1] ?? "Time limit reached." };
    }
  }
  if (plannerFailed) truncated = true;

  const scope = describeScope(context);
  const noMatch = context.passages.length === 0;

  yield { type: "answer_start" };

  const answerMessages: ChatTurn[] = [
    { role: "system", content: ANSWER_SYSTEM },
    {
      role: "user",
      content: buildAnswerPrompt({
        question: input.question,
        passages: context.passages,
        scope,
        noMatch,
        history: input.history,
        documentTitles: input.bundles.map((bundle) => bundle.record.title),
      }),
    },
  ];

  let content = "";
  let emittedQuotes = 0;
  const quotes: QuoteVerification[] = [];
  let streamFailed = false;

  try {
    for await (const token of provider.stream({
      messages: answerMessages,
      temperature: 0.1,
      signal: withDeadline(input.signal, hardDeadline - Date.now()),
    })) {
      content += token;
      yield { type: "token", text: token };

      // The raw text (markers included) is streamed to the browser, which parses
      // the markers itself, so a quote is visible as it is written and then
      // replaced by its verdict the moment verification finishes.
      const completed = findCompletedQuotes(content);
      while (emittedQuotes < completed.length) {
        const match = completed[emittedQuotes];
        emittedQuotes += 1;
        if (!match) break;
        const passageId = match[1] ?? "";
        const rawQuote = (match[2] ?? "").trim();
        const known = context.passages.some((entry) => entry.id === passageId);
        if (!known) {
          warnings.push(
            `A quote cited passage "${passageId}", which was never retrieved; it was located by searching the documents directly.`,
          );
        }

        const resolved = resolveQuote(passageId, rawQuote, context, input.bundles);
        if (!resolved) continue;

        quotes.push(resolved.verification);
        yield { type: "quote", index: emittedQuotes - 1, documentId: resolved.documentId, quote: resolved.verification };
      }
    }
  } catch (error) {
    streamFailed = true;
    if (input.signal?.aborted) {
      warnings.push("Generation was stopped. The part that was written has been kept.");
    } else if (Date.now() >= hardDeadline) {
      // The deadline is the app stopping itself, which is deliberate and is
      // reported as a time limit rather than as a provider error.
      warnings.push(
        "The time limit for one answer was reached, so this answer is incomplete. The part that was written has been kept.",
      );
      yield { type: "warning", message: warnings[warnings.length - 1] ?? "Time limit reached." };
    } else {
      warnings.push(
        error instanceof LlmError
          ? `The model provider failed while writing the answer: ${error.message}`
          : "The answer stream failed part-way through.",
      );
      yield { type: "warning", message: warnings[warnings.length - 1] ?? "The answer stream failed." };
    }
  }

  // A quote left open when the stream ended is incomplete: it is discarded
  // rather than verified against half a sentence.
  const openTags = (content.match(/<quote\b/gi) ?? []).length;
  if (openTags > quotes.length) {
    const message = `${openTags - quotes.length} quote was cut off and discarded because it was incomplete.`;
    warnings.push(message);
    yield { type: "warning", message };
    content = content.replace(/<quote\b[^>]*>[\s\S]*$/i, "").trimEnd();
  }

  const verifiedCount = quotes.filter((quote) => quote.status === "verified").length;
  const postStreamWarnings: string[] = [];
  if (quotes.length === 0 && !abstained(content) && context.passages.length > 0) {
    postStreamWarnings.push("This answer cites no verified quote, so treat it as unsupported.");
  }
  if (quotes.length > 0 && verifiedCount === 0) {
    postStreamWarnings.push("None of the quotes in this answer could be found in the document. They are marked as unverified.");
  }
  if (quotes.some((quote) => quote.status === "partial")) {
    postStreamWarnings.push("Some quotes were only partly found in the document; the missing parts are flagged as unverified.");
  }

  // These are yielded, not just recorded: the interface has to be able to show
  // them, and the message is persisted with them attached.
  for (const message of postStreamWarnings) {
    warnings.push(message);
    yield { type: "warning", message };
  }

  const coverage: CoverageReport = {
    chunksSearched: context.chunksInScope,
    documentsSearched: input.bundles.length,
    noMatch,
    passages: context.passages.map((passage) => ({
      documentId: passage.documentId,
      documentTitle: passage.documentTitle,
      label: passage.label,
      start: passage.start,
      end: passage.end,
      pageStart: passage.pageStart,
      pageEnd: passage.pageEnd,
      score: passage.score,
    })),
    scope,
    rounds,
    truncated,
  };

  yield { type: "coverage", coverage };

  const status: ChatMessageStatus = streamFailed
    ? input.signal?.aborted
      ? "stopped"
      : content.trim().length > 0
        ? "stopped"
        : "error"
    : input.signal?.aborted
      ? "stopped"
      : "complete";

  yield { type: "done", messageId: input.messageId, status, content };
}

function preferredRangesFor(context: ToolContext, documentId: string) {
  return context.passages
    .filter((entry) => entry.documentId === documentId)
    .map((entry) => ({ start: entry.start, end: entry.end }));
}

/**
 * Decide which document a quote belongs to, then verify it against *that*
 * document only. In a multi-document question a quote that exists in one
 * contract must never be checked against another one's text and reported as
 * invented, and vice versa.
 */
function resolveQuote(
  passageId: string,
  rawQuote: string,
  context: ToolContext,
  bundles: DocumentBundle[],
): { documentId: string; verification: QuoteVerification } | null {
  const verifyAgainst = (bundle: DocumentBundle): QuoteVerification =>
    verifyQuote(rawQuote, bundle.document, {
      // The passages the answer was built from decide which occurrence wins.
      preferredRanges: preferredRangesFor(context, bundle.record.id),
    });

  const passage = context.passages.find((entry) => entry.id === passageId);
  if (passage) {
    const bundle = bundles.find((candidate) => candidate.record.id === passage.documentId);
    if (bundle) return { documentId: bundle.record.id, verification: verifyAgainst(bundle) };
  }

  const only = bundles[0];
  if (bundles.length === 1 && only) {
    return { documentId: only.record.id, verification: verifyAgainst(only) };
  }

  // The model named a passage that does not exist (or there are several
  // documents). Try each document and keep the one where the words are real, so
  // a mislabelled id cannot make a genuine quote look invented.
  let fallback: { documentId: string; verification: QuoteVerification } | null = null;
  for (const bundle of bundles) {
    const verification = verifyAgainst(bundle);
    fallback ??= { documentId: bundle.record.id, verification };
    if (verification.status === "verified") return { documentId: bundle.record.id, verification };
  }
  return fallback;
}

function abstained(content: string): boolean {
  return /could not find|cannot find|not covered|does not appear|no provision|unable to find|not addressed/i.test(content);
}

function summarizeToolData(result: ToolResult): string | undefined {
  const data = result.data;
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  if (Array.isArray(record.passages)) {
    return (record.passages as Array<Passage>)
      .slice(0, 3)
      .map((passage) => `${passage.id} · ${passage.label}`)
      .join("\n");
  }
  if (Array.isArray(record.sections)) {
    return (record.sections as Array<{ document?: string; location?: string }>)
      .map((section) => `${section.document ?? ""} · ${section.location ?? ""}`)
      .join("\n");
  }
  return undefined;
}

/**
 * A sentence the user can check, describing exactly how much of the documents
 * this answer is based on. Rule 4 of the brief — never sound as though the whole
 * document was read when it was not — depends on this being accurate.
 */
export function describeScope(context: ToolContext): string {
  const documents = context.bundles
    .map((bundle) => {
      const pages = bundle.record.pageCount > 0 ? `${bundle.record.pageCount} pages, ` : "";
      return `${bundle.record.title} (${pages}${bundle.chunks.length} clauses)`;
    })
    .join("; ");

  const searched = context.chunksInScope;
  const read = context.passages.length;
  return `all ${searched} clauses of ${documents} were searched lexically; ${read} passage${read === 1 ? "" : "s"} ${read === 1 ? "was" : "were"} read in full. Other clauses were not read, so a passage that uses entirely different wording for the same idea may not have been retrieved.`;
}
