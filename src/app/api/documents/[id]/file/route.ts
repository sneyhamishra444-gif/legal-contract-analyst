import { jsonError } from "@/lib/api/responses";
import { getDocumentRecord } from "@/lib/storage/repository";

export const runtime = "nodejs";

/**
 * The original file, served back unchanged. The application never renders the
 * original layout — quotes are highlighted in the extracted text, which is what
 * makes offset-accurate highlighting possible — so this is here so a reviewer can
 * always check the app's text against the file it came from.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  const record = await getDocumentRecord(id);
  if (!record) {
    return jsonError(404, { code: "not_found", message: "That document is not in the library." });
  }

  const bytes = Buffer.from(record.fileBase64, "base64");
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type":
        record.kind === "pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "content-disposition": `inline; filename="${record.title.replace(/[^\w.-]+/g, "_")}"`,
      "cache-control": "private, max-age=60",
    },
  });
}
