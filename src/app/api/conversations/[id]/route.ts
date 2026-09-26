import { jsonError, jsonOk } from "@/lib/api/responses";
import { getConversation, listMessages } from "@/lib/storage/repository";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  const conversation = await getConversation(id);
  if (!conversation) {
    return jsonError(404, { code: "not_found", message: "That conversation no longer exists." });
  }
  return jsonOk({ conversation, messages: await listMessages(id) });
}
