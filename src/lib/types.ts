import type { QuoteVerification } from "@/lib/text/verify";

export type DocumentKind = "pdf" | "docx";

export type StoredDocument = {
  id: string;
  title: string;
  kind: DocumentKind;
  byteSize: number;
  pageCount: number;
  charCount: number;
  clauseCount: number;
  createdAt: string;
  warnings: string[];
};

export type DocumentRecord = StoredDocument & {
  contentHash: string;
  /** Original bytes, base64 encoded, so the uploaded file can be opened again. */
  fileBase64: string;
  text: string;
  pages: Array<{ number: number; start: number; end: number }>;
};

export type AgentStepKind = "thought" | "tool" | "result" | "decision" | "note";

export type AgentStep = {
  id: string;
  kind: AgentStepKind;
  /** One line shown in the live "what the agent is doing" log. */
  title: string;
  detail?: string;
  at: string;
  round?: number;
};

export type CoverageReport = {
  /** Chunks that were searchable for this answer. */
  chunksSearched: number;
  documentsSearched: number;
  /** True when retrieval found no lexical evidence for the question. */
  noMatch: boolean;
  /** Retrieved passages, in the order the model saw them. */
  passages: Array<{
    documentId: string;
    documentTitle: string;
    label: string;
    start: number;
    end: number;
    pageStart: number | null;
    pageEnd: number | null;
    score: number;
  }>;
  /** Human-readable statement of exactly how much of the documents was read. */
  scope: string;
  rounds: number;
  /** Set when the agent hit its round or step budget before concluding. */
  truncated: boolean;
};

export type MessageMeta = {
  quotes: QuoteVerification[];
  steps: AgentStep[];
  coverage: CoverageReport | null;
  model: string;
  /** "offline" means the deterministic fallback answered, not a language model. */
  provider: "llm" | "offline";
  warnings: string[];
};

export type ChatRole = "user" | "assistant";
export type ChatMessageStatus = "complete" | "stopped" | "error";

export type ChatMessage = {
  id: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  status: ChatMessageStatus;
  createdAt: string;
  meta: MessageMeta;
};

export type Conversation = {
  id: string;
  title: string;
  documentIds: string[];
  createdAt: string;
  updatedAt: string;
};

export const EMPTY_MESSAGE_META: MessageMeta = {
  quotes: [],
  steps: [],
  coverage: null,
  model: "unknown",
  provider: "offline",
  warnings: [],
};
