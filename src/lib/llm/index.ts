import { readLlmConfig } from "./config";
import { createOfflineProvider } from "./offline";
import { createOpenAiCompatibleProvider } from "./openai_compatible";
import type { LlmProvider } from "./provider";

/**
 * The provider for this request.
 *
 * A missing or placeholder key is not an error state — it selects the offline
 * extractor, and the interface says so on the answer itself. That is deliberate:
 * a demo that refuses to work without a funded key is worse than one that
 * answers from the document and is clear about how.
 */
export function getProvider(): LlmProvider {
  const config = readLlmConfig();
  if (!config.apiKey) return createOfflineProvider();
  return createOpenAiCompatibleProvider(config);
}

export { readAgentMaxRounds, readLlmConfig, describeProvider } from "./config";
export { createOfflineProvider } from "./offline";
export { createOpenAiCompatibleProvider } from "./openai_compatible";
export * from "./provider";
