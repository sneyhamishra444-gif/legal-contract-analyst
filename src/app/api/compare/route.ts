import { jsonError, readJson, streamEvents } from "@/lib/api/responses";
import { type ComparisonResult, compareDocuments, formatChangeForSummary } from "@/lib/compare/compare";
import { getProvider } from "@/lib/llm";
import { COMPARE_SYSTEM } from "@/lib/agent/prompts";
import { loadDocumentBundles } from "@/lib/storage/documents";
import { saveComparison } from "@/lib/storage/repository";

export const runtime = "nodejs";
export const maxDuration = 60;

export type CompareStreamEvent =
  | { type: "diff"; result: ComparisonResult }
  | { type: "summary_start" }
  | { type: "token"; text: string }
  | { type: "warning"; message: string }
  | { type: "done"; summary: string; comparisonId: string | null }
  | { type: "error"; message: string; code: string };

type CompareRequest = { leftDocumentId?: string; rightDocumentId?: string };

export async function POST(request: Request): Promise<Response> {
  const body = await readJson<CompareRequest>(request);
  if (!body) {
    return jsonError(400, { code: "bad_request", message: "The request body must be JSON." });
  }

  const leftId = body.leftDocumentId ?? "";
  const rightId = body.rightDocumentId ?? "";
  if (!leftId || !rightId) {
    return jsonError(400, { code: "bad_request", message: "Choose two documents to compare." });
  }
  if (leftId === rightId) {
    return jsonError(400, {
      code: "same_document",
      message: "Pick two different versions. Comparing a document with itself finds nothing.",
    });
  }

  const [left, right] = await loadDocumentBundles([leftId, rightId]);
  if (!left || !right) {
    return jsonError(404, { code: "not_found", message: "One of those documents is no longer in the library." });
  }

  const provider = getProvider();

  return streamEvents<CompareStreamEvent>({
    async produce(emit) {
      // The diff itself is deterministic and fast, so it is sent immediately and
      // the interface can render the change list while the prose is still being
      // written. If the model fails, the diff is unaffected — the changes are the
      // authoritative part, not the summary.
      let result: ComparisonResult;
      try {
        result = compareDocuments(left, right);
      } catch (error) {
        emit({
          type: "error",
          message: `These documents could not be compared: ${error instanceof Error ? error.message : "unknown error"}`,
          code: "compare_failed",
        });
        return;
      }

      emit({ type: "diff", result });
      emit({ type: "summary_start" });

      const changes = result.changes
        .filter((change) => change.significance !== "low" || change.kind !== "reworded")
        .slice(0, 24)
        .map(formatChangeForSummary);

      let summary = "";
      try {
        for await (const token of provider.stream({
          messages: [
            { role: "system", content: COMPARE_SYSTEM },
            {
              role: "user",
              content: [
                `LEFT: ${result.left.title} (${result.left.clauseCount} clauses)`,
                `RIGHT: ${result.right.title} (${result.right.clauseCount} clauses)`,
                `COUNTS: ${JSON.stringify(result.counts)}`,
                `CHANGES_JSON: ${JSON.stringify(changes)}`,
                "Write the summary now.",
              ].join("\n"),
            },
          ],
          temperature: 0.2,
          signal: request.signal,
        })) {
          summary += token;
          emit({ type: "token", text: token });
        }
      } catch (error) {
        emit({
          type: "warning",
          message: `The summary could not be generated (${error instanceof Error ? error.message : "unknown error"}). The change list above is complete and unaffected.`,
        });
      }

      const comparisonId =
        result.changes.length > 0
          ? await saveComparison({
              leftDocumentId: leftId,
              rightDocumentId: rightId,
              payload: { result, summary, provider: provider.kind },
            })
          : null;

      emit({ type: "done", summary, comparisonId });
    },
  });
}
