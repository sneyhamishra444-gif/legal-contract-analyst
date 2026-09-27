/**
 * Provider configuration.
 *
 * Key, base URL and model name all come from the environment, as the brief
 * requires, and nothing here is ever written to a file. A value that is still an
 * obvious placeholder (`<your_api_key>`, `sk-xxx`, `changeme`) is treated as
 * absent: the app then runs in offline mode and says so, rather than firing
 * requests at a provider with a fake key and surfacing a confusing 401.
 */

export type LlmConfig = {
  apiKey: string | null;
  baseUrl: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  appUrl: string | null;
  appTitle: string;
};

const PLACEHOLDER = /^(<.*>|your[_-]?api[_-]?key|sk-?x+|changeme|todo|none|null|undefined)$/i;

export function readLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const rawKey = env.LLM_API_KEY?.trim() ?? "";
  const apiKey = rawKey.length > 0 && !PLACEHOLDER.test(rawKey) ? rawKey : null;

  return {
    apiKey,
    baseUrl: (env.LLM_BASE_URL?.trim() || "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
    model: env.LLM_MODEL?.trim() || "openai/gpt-4o-mini",
    maxTokens: Number.parseInt(env.LLM_MAX_TOKENS ?? "1200", 10) || 1200,
    timeoutMs: Number.parseInt(env.LLM_TIMEOUT_MS ?? "60000", 10) || 60_000,
    appUrl: env.LLM_APP_URL?.trim() || null,
    appTitle: env.LLM_APP_TITLE?.trim() || "Legal Contract Analyst",
  };
}

/** Round budget for the agent loop, clamped so a bad env value cannot run away. */
export function readAgentMaxRounds(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.AGENT_MAX_ROUNDS ?? "6", 10);
  if (!Number.isFinite(parsed)) return 6;
  return Math.min(10, Math.max(2, parsed));
}

/**
 * Wall-clock budget for one complete run: research plus writing the answer.
 *
 * The round and tool-call caps bound how much work happens; this bounds how long
 * it takes, which is a different thing and the one a hosting platform enforces.
 * Without it, a slow provider gets the request killed mid-sentence by the
 * platform: the stream stops wherever it was and nothing is saved. With it, the
 * app stops on its own terms and produces a shorter answer that says research was
 * cut short.
 *
 * The default sits inside a 60-second serverless function limit with room left
 * over to write and persist the answer. The floor is above the amount reserved
 * for the answer, so raising it can never leave research with no time at all.
 */
export function readAgentBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.AGENT_BUDGET_MS ?? "50000", 10);
  if (!Number.isFinite(parsed)) return 50_000;
  return Math.min(600_000, Math.max(25_000, parsed));
}

export function describeProvider(config: LlmConfig): string {
  return config.apiKey ? `${config.model} via ${config.baseUrl}` : "offline deterministic extractor (no API key set)";
}
