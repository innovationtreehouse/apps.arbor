// Model calls go through OpenRouter's Anthropic-compatible endpoint.
export const DEFAULT_MODEL = "anthropic/claude-opus-4.6";
// Research stages: a cheap model condenses each document, a second one picks the evidence.
export const DEFAULT_FETCH_MODEL = "google/gemini-3.5-flash-lite";
export const DEFAULT_DECIDE_MODEL = "google/gemini-3.8-flash";
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
export function resolveModel(stored?: string, envValue = process.env.MODEL, fallback = DEFAULT_MODEL): string {
  for (const id of [stored, envValue]) {
    if (id?.includes("/")) return id;
    if (id) console.warn(`[agent] ignoring model "${id}": not an OpenRouter provider/model ID`);
  }
  return fallback;
}

export interface Usage { calls: number; prompt_tokens: number; completion_tokens: number; cost: number }
export const emptyUsage = (): Usage => ({ calls: 0, prompt_tokens: 0, completion_tokens: 0, cost: 0 });

// One OpenRouter chat completion (OpenAI-compatible endpoint) for the research stages.
export async function chat(model: string, prompt: string, usage: Usage, signal?: AbortSignal): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is required");
  const res = await fetch(`${openRouterBaseUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1200,
      // Flash models reason by default; that can spend max_tokens and leave no JSON.
      reasoning: { effort: "none" },
      response_format: { type: "json_object" },
      usage: { include: true },
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status} for ${model}`);
  const body = await res.json() as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  };
  usage.calls++;
  usage.prompt_tokens += body.usage?.prompt_tokens ?? 0;
  usage.completion_tokens += body.usage?.completion_tokens ?? 0;
  usage.cost += body.usage?.cost ?? 0;
  return body.choices?.[0]?.message?.content ?? "";
}

// Models wrap JSON in prose or code fences; take the outermost {...} and parse that.
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
