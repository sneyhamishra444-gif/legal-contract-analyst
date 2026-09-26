/**
 * OpenAI-compatible chat completions over `fetch`.
 *
 * Written by hand rather than with a vendor SDK for one reason: the same code
 * path has to work against OpenRouter, OpenAI and a local server, and the SSE
 * format is small enough to parse correctly here. Aborting is wired all the way
 * through — when the user presses stop, the HTTP request is aborted, so the
 * provider stops generating and the bill stops growing.
 */

import { type LlmConfig } from "./config";
import {
  type ChatTurn,
  type CompletionRequest,
  type LlmProvider,
  type StreamRequest,
  LlmError,
} from "./provider";

type OpenAiChunk = {
  choices?: Array<{
    delta?: { content?: string | null };
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  error?: { message?: string; code?: string | number };
};

function endpoint(config: LlmConfig): string {
  return `${config.baseUrl}/chat/completions`;
}

function headers(config: LlmConfig): Record<string, string> {
  const result: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${config.apiKey ?? ""}`,
  };
  // OpenRouter attributes traffic by these headers; harmless elsewhere.
  if (config.baseUrl.includes("openrouter") && config.appUrl) {
    result["http-referer"] = config.appUrl;
    result["x-title"] = config.appTitle;
  }
  return result;
}

async function describeHttpError(response: Response): Promise<LlmError> {
  let detail = "";
  try {
    const body = (await response.json()) as OpenAiChunk;
    detail = body.error?.message ?? "";
  } catch {
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      detail = "";
    }
  }
  const hint =
    response.status === 401
      ? " The API key was rejected. Check LLM_API_KEY."
      : response.status === 402
        ? " The provider reports insufficient credit for this key."
        : response.status === 404
          ? " The model name may not exist on this provider. Check LLM_MODEL."
          : response.status === 429
            ? " The provider is rate limiting this key."
            : "";
  return new LlmError(`Provider returned ${response.status} ${response.statusText}.${hint} ${detail}`.trim(), response.status);
}

async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const rawEvent = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf("\n\n");

        for (const line of rawEvent.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") return;
          try {
            const parsed = JSON.parse(payload) as OpenAiChunk;
            const delta = parsed.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length > 0) yield delta;
          } catch {
            // A partial or vendor-specific frame; ignore rather than abort the answer.
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function buildBody(config: LlmConfig, request: CompletionRequest | StreamRequest, stream: boolean) {
  const messages = request.messages as ChatTurn[];
  const body: Record<string, unknown> = {
    model: config.model,
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    max_tokens: request.maxTokens ?? config.maxTokens,
    temperature: request.temperature ?? 0.2,
    stream,
  };
  if (request.json) body.response_format = { type: "json_object" };
  return JSON.stringify(body);
}

export function createOpenAiCompatibleProvider(config: LlmConfig): LlmProvider {
  return {
    label: `${config.model} via ${config.baseUrl}`,
    model: config.model,
    kind: "llm",
    available: config.apiKey !== null,

    async complete(request: CompletionRequest): Promise<string> {
      const timeout = AbortSignal.timeout(config.timeoutMs);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

      const response = await fetch(endpoint(config), {
        method: "POST",
        headers: headers(config),
        body: buildBody(config, request, false),
        signal,
      });

      if (!response.ok) throw await describeHttpError(response);
      const payload = (await response.json()) as OpenAiChunk;
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new LlmError("The provider returned an empty response.");
      }
      return content;
    },

    async *stream(request: StreamRequest): AsyncGenerator<string, void, unknown> {
      const timeout = AbortSignal.timeout(config.timeoutMs);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

      const response = await fetch(endpoint(config), {
        method: "POST",
        headers: headers(config),
        body: buildBody(config, request, true),
        signal,
      });

      if (!response.ok) throw await describeHttpError(response);
      if (!response.body) throw new LlmError("The provider returned no response body.");

      yield* readSse(response.body);
    },
  };
}
