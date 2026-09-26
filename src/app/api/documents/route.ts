import { ExtractionError, extractDocument } from "@/lib/extract";
import { jsonError, jsonOk } from "@/lib/api/responses";
import { deleteDocument, insertDocument, listDocuments } from "@/lib/storage/repository";
import { forgetDocumentBundle, loadDocumentBundle } from "@/lib/storage/documents";
import { extractClauseOutline } from "@/lib/text/chunk";
import { createSearchableDocument } from "@/lib/text/document";

/** Uploads must run on Node (PDF and DOCX parsing need it) and may take a while. */
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(): Promise<Response> {
  return jsonOk({ documents: await listDocuments() });
}

export async function POST(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError(400, {
      code: "bad_request",
      message: "The upload could not be read.",
      hints: ["Send the file as multipart/form-data under the field name `file`."],
    });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return jsonError(400, {
      code: "no_file",
      message: "No file was included in the upload.",
      hints: ["Choose a PDF or DOCX contract and try again."],
    });
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const extraction = await extractDocument({ name: file.name, bytes });

    // The clause count is shown in the library, so it is computed here from the
    // same structure detection the rest of the app uses rather than estimated.
    const searchable = createSearchableDocument({
      id: "pending",
      title: file.name,
      text: extraction.text,
      pages: extraction.pages,
    });
    const clauseCount = extractClauseOutline(searchable).filter((clause) => clause.number !== null).length;

    const { document, duplicate } = await insertDocument({
      title: file.name,
      kind: extraction.kind,
      bytes,
      text: extraction.text,
      pages: extraction.pages,
      warnings: extraction.warnings,
      clauseCount,
    });

    // Warm the cache so the first question does not pay for chunking.
    const bundle = await loadDocumentBundle(document.id);

    return jsonOk({
      document: { ...document, clauseCount: bundle?.clauses.filter((clause) => clause.number !== null).length ?? clauseCount },
      duplicate,
      warnings: extraction.warnings,
    });
  } catch (error) {
    if (error instanceof ExtractionError) {
      const status = error.code === "too-large" ? 413 : error.code === "unreadable" ? 422 : 415;
      return jsonError(status, { code: error.code, message: error.userMessage, hints: error.hints });
    }
    return jsonError(500, {
      code: "extract_failed",
      message: "That file could not be processed.",
      hints: [error instanceof Error ? error.message : "Unknown error"],
    });
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) {
    return jsonError(400, { code: "bad_request", message: "A document id is required." });
  }
  const deleted = await deleteDocument(id);
  forgetDocumentBundle(id);
  if (!deleted) {
    return jsonError(404, { code: "not_found", message: "That document does not exist." });
  }
  return jsonOk({ ok: true, id });
}
