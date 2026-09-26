import { jsonError, jsonOk } from "@/lib/api/responses";
import { deleteConversationMessages, listConversations } from "@/lib/storage/repository";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const documentId = new URL(request.url).searchParams.get("documentId") ?? undefined;
  return jsonOk({ conversations: await listConversations(documentId) });
}

export async function DELETE(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return jsonError(400, { code: "bad_request", message: "A conversation id is required." });
  await deleteConversationMessages(id);
  const db = await getDb();
  await db.query(`delete from conversations where id = ?`, [id]);
  return jsonOk({ ok: true, id });
}
