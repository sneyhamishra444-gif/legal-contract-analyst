import { jsonOk } from "@/lib/api/responses";
import { describeDbTarget, getDb, storageNote } from "@/lib/db";
import { readAgentMaxRounds, readLlmConfig } from "@/lib/llm/config";

export const runtime = "nodejs";

/**
 * Deliberately public and explicit about the configuration: whether a model key
 * is present and which store is in use are the two things most likely to explain
 * a surprising deployment, and both are safe to state (no key material is
 * returned, only whether one exists).
 */
export async function GET(): Promise<Response> {
  const config = readLlmConfig();
  let database = "unavailable";
  try {
    const db = await getDb();
    await db.query("select 1");
    database = describeDbTarget();
  } catch (error) {
    database = `error: ${error instanceof Error ? error.message : "unknown"}`;
  }

  const note = storageNote();

  return jsonOk({
    ok: true,
    database,
    ...(note ? { storageWarning: note } : {}),
    provider: {
      configured: config.apiKey !== null,
      baseUrl: config.baseUrl,
      model: config.model,
      mode: config.apiKey ? "language model" : "offline deterministic extractor",
    },
    agent: { maxRounds: readAgentMaxRounds() },
  });
}
