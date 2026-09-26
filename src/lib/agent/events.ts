import type { QuoteVerification } from "@/lib/text/verify";
import type { AgentStep, ChatMessageStatus, CoverageReport } from "@/lib/types";

/**
 * The event protocol streamed to the browser (newline-delimited JSON over a
 * `text/event-stream` response).
 *
 * Quotes get their own event *as they close*, not at the end, so the interface
 * can show each quote turning from "checking" to "verified" or "not found"
 * while the answer is still being written. That is the honest presentation of
 * verification: it happens per quote, as the quote arrives.
 */
export type StreamEvent =
  | {
      type: "start";
      conversationId: string;
      messageId: string;
      provider: "llm" | "offline";
      model: string;
      maxRounds: number;
      documents: Array<{ id: string; title: string; pages: number; clauses: number }>;
    }
  | { type: "step"; step: AgentStep }
  | { type: "answer_start" }
  | { type: "token"; text: string }
  | { type: "quote"; index: number; documentId: string; quote: QuoteVerification }
  | { type: "coverage"; coverage: CoverageReport }
  | { type: "warning"; message: string }
  | { type: "done"; messageId: string; status: ChatMessageStatus; content: string }
  | { type: "error"; message: string; code: string };

/** A passage as the model sees it, and as the interface references it. */
export type Passage = {
  id: string;
  documentId: string;
  documentTitle: string;
  /** "clause 11, LIMITATION OF LIABILITY, page 4" */
  label: string;
  start: number;
  end: number;
  pageStart: number | null;
  pageEnd: number | null;
  score: number;
  text: string;
  /** True when `text` was shortened for the prompt. */
  truncated: boolean;
};

export function encodeEvent(event: StreamEvent): string {
  return `${JSON.stringify(event)}\n`;
}
