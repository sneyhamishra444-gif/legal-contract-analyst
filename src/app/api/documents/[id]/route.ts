import { jsonError, jsonOk } from "@/lib/api/responses";
import { loadDocumentBundle } from "@/lib/storage/documents";
import { listConversations } from "@/lib/storage/repository";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  const bundle = await loadDocumentBundle(id);
  if (!bundle) {
    return jsonError(404, { code: "not_found", message: "That document is not in the library." });
  }

  const { record } = bundle;
  return jsonOk({
    document: {
      id: record.id,
      title: record.title,
      kind: record.kind,
      byteSize: record.byteSize,
      pageCount: record.pageCount,
      charCount: record.charCount,
      clauseCount: record.clauseCount,
      createdAt: record.createdAt,
      warnings: record.warnings,
    },
    text: record.text,
    pages: record.pages,
    clauses: bundle.clauses,
    conversations: await listConversations(record.id),
  });
}
