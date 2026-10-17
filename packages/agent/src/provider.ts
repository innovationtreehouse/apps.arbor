// Model calls go through OpenRouter's Anthropic-compatible endpoint.
export const DEFAULT_MODEL = "anthropic/claude-opus-4.6";
export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api";

export function openRouterBaseUrl(): string {
  return process.env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE_URL;
}

// Env for the SDK subprocess. ANTHROPIC_API_KEY must be an explicit empty
// string so the CLI uses the bearer token instead of an inherited Anthropic key.
export function providerEnv(): Record<string, string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is required");
  return {
    ANTHROPIC_BASE_URL: openRouterBaseUrl(),
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_API_KEY: "",
  };
}

// OpenRouter IDs are "provider/model". A bare ID stored before the cutover
// (e.g. "claude-opus-4-6") would fail every request, so fall back instead.
export function resolveModel(stored?: string): string {
  for (const id of [stored, process.env.MODEL]) {
    if (id?.includes("/")) return id;
    if (id) console.warn(`[agent] ignoring model "${id}": not an OpenRouter provider/model ID`);
  }
  return DEFAULT_MODEL;
}
