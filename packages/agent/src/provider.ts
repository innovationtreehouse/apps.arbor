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
