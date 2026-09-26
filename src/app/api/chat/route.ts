import { runAgent } from "@/lib/agent/runner";
import type { StreamEvent } from "@/lib/agent/events";
import { jsonError, readJson, streamEvents, truncateTitle } from "@/lib/api/responses";
import { getProvider } from "@/lib/llm";
import { loadDocumentBundles } from "@/lib/storage/documents";
import {
  createConversation,
  getConversation,
  insertMessage,
  listMessages,
} from "@/lib/storage/repository";
import type { AgentStep, CoverageReport, MessageMeta } from "@/lib/types";
import type { QuoteVerification } from "@/lib/text/verify";

export const runtime = "nodejs";
/** Vercel's Hobby plan allows 60s; a long answer needs it. */
export const maxDuration = 60;

type ChatRequest = {
  documentIds?: string[];
  question?: string;
  conversationId?: string;
};

export async function POST(request: Request): Promise<Response> {
  const body = await readJson<ChatRequest>(request);
  if (!body) {
    return jsonError(400, { code: "bad_request", message: "The request body must be JSON." });
  }

  const question = (body.question ?? "").trim();
  const documentIds = [...new Set(body.documentIds ?? [])].filter((id) => typeof id === "string");

  if (question.length === 0) {
    return jsonError(400, { code: "empty_question", message: "Ask a question first." });
  }
  if (question.length > 2000) {
    return jsonError(400, {
      code: "question_too_long",
      message: "That question is too long (limit 2000 characters).",
    });
  }
  if (documentIds.length === 0) {
    return jsonError(400, {
      code: "no_documents",
      message: "Select at least one document to ask about.",
    });
  }

  const bundles = await loadDocumentBundles(documentIds);
  if (bundles.length === 0) {
    return jsonError(404, {
      code: "documents_missing",
      message: "Those documents are no longer in the library.",
    });
  }

  const conversation = body.conversationId
    ? ((await getConversation(body.conversationId)) ?? (await createConversation({ title: truncateTitle(question), documentIds })))
    : await createConversation({ title: truncateTitle(question), documentIds });

  const history = (await listMessages(conversation.id)).map((message) => ({
    role: message.role,
    content: message.content,
  }));

  await insertMessage({ conversationId: conversation.id, role: "user", content: question, status: "complete" });

  const provider = getProvider();

  // The answer is generated inside the stream, and the assistant message is
  // written once the generator finishes — including when the reader has already
  // gone away, which is what makes "stop" keep the partial answer.
  return streamEvents<StreamEvent>({
    async produce(emit) {
      const steps: AgentStep[] = [];
      const quotes: QuoteVerification[] = [];
      let coverage: CoverageReport | null = null;
      let warnings: string[] = [];
      let content = "";
      let status: "complete" | "stopped" | "error" = "error";

      try {
        for await (const event of runAgent({
          bundles,
          question,
          history: history.slice(-6),
          conversationId: conversation.id,
          messageId: "streaming",
          signal: request.signal,
        })) {
          if (event.type === "step") steps.push(event.step);
          if (event.type === "quote") quotes.push(event.quote);
          if (event.type === "coverage") coverage = event.coverage;
          if (event.type === "warning") warnings = [...warnings, event.message];
          if (event.type === "done") {
            content = event.content;
            status = event.status;
          }
          emit(event);
        }
      } finally {
        // Runs even when the reader disconnected, so a stopped answer is stored
        // rather than lost. An answer that produced nothing at all is not saved
        // as an empty message.
        if (content.trim().length > 0 || quotes.length > 0) {
          const meta: MessageMeta = {
            quotes,
            steps,
            coverage,
            model: provider.model,
            provider: provider.kind,
            warnings,
          };
          await insertMessage({
            conversationId: conversation.id,
            role: "assistant",
            content,
            status,
            meta,
          });
        } else {
          emit({
            type: "error",
            message: "No answer was produced, so nothing was saved for this question.",
            code: "no_answer",
          } as StreamEvent);
        }
      }
    },
  });
}
