/**
 * HTTP plumbing shared by the route handlers.
 *
 * Streaming uses newline-delimited JSON over a normal fetch response rather than
 * `EventSource`, because the client needs to POST a question and `EventSource`
 * cannot. Each line is one event object; the browser reads the body as a stream
 * and parses a line at a time.
 *
 * The important property of `streamEvents` is what happens when the reader goes
 * away. The producer keeps running long enough to finish its own bookkeeping —
 * which is how a stopped answer still gets saved instead of vanishing.
 */

export type ApiError = {
  code: string;
  message: string;
  hints?: string[];
};

export function jsonError(status: number, error: ApiError): Response {
  return Response.json({ error }, { status });
}

export function jsonOk<T>(body: T): Response {
  return Response.json(body);
}

export function streamEvents<E>(options: {
  produce: (emit: (event: E) => void) => Promise<void>;
  /** Called when the reader disconnects, before the producer is asked to stop. */
  onCancel?: () => void;
}): Response {
  const encoder = new TextEncoder();
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: E) => {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          cancelled = true;
        }
      };

      try {
        await options.produce(emit);
      } catch (error) {
        emit({
          type: "error",
          message: error instanceof Error ? error.message : "Unexpected failure while streaming.",
          code: "stream_failed",
        } as E);
      } finally {
        if (!cancelled) {
          try {
            controller.close();
          } catch {
            // Already closed by the runtime; nothing to do.
          }
        }
      }
    },
    cancel() {
      cancelled = true;
      options.onCancel?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      // Stops proxy buffering from holding the whole answer back.
      "x-accel-buffering": "no",
    },
  });
}

export async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

export function truncateTitle(value: string, max = 70): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
