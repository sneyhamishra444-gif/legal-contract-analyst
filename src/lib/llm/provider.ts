/**
 * The provider seam.
 *
 * Anything that speaks the OpenAI chat-completions protocol works here:
 * OpenRouter, OpenAI, Together, Groq, or a local llama.cpp / Ollama server. That
 * is one interface to test rather than one per vendor, and it is why swapping
 * providers is an environment change rather than a code change.
 *
 * The offline provider implements the same interface, which is what lets the
 * whole agent loop, the streaming plumbing and the quote verifier be tested
 * without a network call or a key.
 */

export type ChatRoleName = "system" | "user" | "assistant";

export type ChatTurn = {
  role: ChatRoleName;
  content: string;
};

export type CompletionRequest = {
  messages: ChatTurn[];
  maxTokens?: number;
  temperature?: number;
  /** Ask the provider for a JSON object where the API supports it. */
  json?: boolean;
  signal?: AbortSignal;
};

export type StreamRequest = CompletionRequest;

export type LlmProvider = {
  /** Shown in the interface so the user knows what answered. */
  label: string;
  model: string;
  kind: "llm" | "offline";
  available: boolean;
  complete(request: CompletionRequest): Promise<string>;
  stream(request: StreamRequest): AsyncGenerator<string, void, unknown>;
};

export class LlmError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.retryable = status === null || status === 429 || status >= 500;
  }
}

/**
 * Parse a JSON object out of a model response.
 *
 * Models reliably produce *almost* JSON: fenced in ```json, wrapped in a
 * sentence, with a trailing comma, or with a tool call in a tag. Since a
 * malformed plan must not crash a request, this tries the cheap repairs in order
 * and returns null rather than throwing — the caller decides what a failure
 * means (usually: tell the model what was wrong and let it retry once).
 */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  const trimmed = raw.trim();

  candidates.push(trimmed);

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const tagged = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i.exec(trimmed);
  if (tagged?.[1]) candidates.push(tagged[1].trim());

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    for (const attempt of [candidate, candidate.replace(/,\s*([}\]])/g, "$1")]) {
      try {
        const parsed = JSON.parse(attempt);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // try the next repair
      }
    }
  }

  return null;
}

/** Pull `{ tool, arguments }` out of the several shapes models use. */
export function extractAction(parsed: Record<string, unknown>): { tool: string; args: unknown } | null {
  const nested = (value: unknown): { tool: string; args: unknown } | null => {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const name =
      (typeof record.tool === "string" && record.tool) ||
      (typeof record.name === "string" && record.name) ||
      (typeof record.tool_name === "string" && record.tool_name) ||
      null;
    if (!name) return null;
    return {
      tool: name,
      args: record.arguments ?? record.args ?? record.parameters ?? {},
    };
  };

  return nested(parsed.action) ?? nested(parsed.tool_call) ?? nested(parsed) ?? null;
}
