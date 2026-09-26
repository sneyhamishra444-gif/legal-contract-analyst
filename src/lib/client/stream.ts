/**
 * Browser-side reader for the newline-delimited JSON streams the API returns.
 *
 * Reading the body as a stream (rather than awaiting `response.json()`) is what
 * makes tokens arrive as they are generated, and it is what allows a request to
 * be aborted mid-answer with the part already received kept intact.
 */

export type StreamHandlers<T> = {
  onEvent: (event: T) => void;
  signal?: AbortSignal;
};

export class ApiRequestError extends Error {
  readonly code: string;
  readonly hints: string[];

  constructor(message: string, code = "request_failed", hints: string[] = []) {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
    this.hints = hints;
  }
}

export async function postStream<T>(url: string, body: unknown, handlers: StreamHandlers<T>): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: handlers.signal,
  });

  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    let code = "request_failed";
    let hints: string[] = [];
    try {
      const payload = (await response.json()) as { error?: { message?: string; code?: string; hints?: string[] } };
      message = payload.error?.message ?? message;
      code = payload.error?.code ?? code;
      hints = payload.error?.hints ?? [];
    } catch {
      // Keep the generic message.
    }
    throw new ApiRequestError(message, code, hints);
  }

  if (!response.body) {
    throw new ApiRequestError("The server returned no response body.", "no_body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        try {
          handlers.onEvent(JSON.parse(line) as T);
        } catch {
          // A malformed frame must not abandon an otherwise good answer.
        }
      }
    }

    const tail = buffer.trim();
    if (tail) {
      try {
        handlers.onEvent(JSON.parse(tail) as T);
      } catch {
        // ignore
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) {
    throw new ApiRequestError(payload?.error?.message ?? `Request failed (${response.status}).`);
  }
  return payload;
}
