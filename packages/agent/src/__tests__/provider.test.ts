import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL, DEFAULT_OPENROUTER_BASE_URL, chat, emptyUsage, openRouterBaseUrl, parseJsonObject, providerEnv, resolveModel } from "../provider.js";

const saved = { k: process.env.OPENROUTER_API_KEY, b: process.env.OPENROUTER_BASE_URL };
beforeEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_BASE_URL;
});
afterEach(() => {
  for (const [name, v] of [["OPENROUTER_API_KEY", saved.k], ["OPENROUTER_BASE_URL", saved.b]] as const) {
    if (v === undefined) delete process.env[name];
    else process.env[name] = v;
  }
});

describe("provider", () => {
  it("throws without OPENROUTER_API_KEY", () => {
    expect(() => providerEnv()).toThrow("OPENROUTER_API_KEY is required");
  });

  it("uses the default base URL", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-x";
    expect(openRouterBaseUrl()).toBe(DEFAULT_OPENROUTER_BASE_URL);
    expect(providerEnv()).toEqual({
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_AUTH_TOKEN: "sk-or-x",
      ANTHROPIC_API_KEY: "",
    });
  });

  it("honors OPENROUTER_BASE_URL", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-x";
    process.env.OPENROUTER_BASE_URL = "http://proxy/api";
    expect(providerEnv().ANTHROPIC_BASE_URL).toBe("http://proxy/api");
  });

  it("sets ANTHROPIC_API_KEY to the empty string, not undefined", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-x";
    const env = providerEnv();
    expect("ANTHROPIC_API_KEY" in env).toBe(true);
    expect(env.ANTHROPIC_API_KEY).toBe("");
  });
});

describe("resolveModel", () => {
  afterEach(() => { delete process.env.MODEL; });

  it("uses a stored provider/model ID", () => {
    expect(resolveModel("anthropic/claude-haiku-4.5")).toBe("anthropic/claude-haiku-4.5");
  });

  it("falls back past a bare pre-OpenRouter ID", () => {
    process.env.MODEL = "anthropic/claude-sonnet-4.6";
    expect(resolveModel("claude-opus-4-6")).toBe("anthropic/claude-sonnet-4.6");
    delete process.env.MODEL;
    expect(resolveModel("claude-opus-4-6")).toBe(DEFAULT_MODEL);
  });

  it("defaults when nothing is set", () => {
    expect(resolveModel(undefined)).toBe(DEFAULT_MODEL);
  });
});

describe("chat", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts to OpenRouter chat completions and adds usage", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-x";
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"a":1}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.25 },
    })));
    vi.stubGlobal("fetch", fetchMock);
    const usage = emptyUsage();
    expect(await chat("google/x", "hi", usage)).toBe('{"a":1}');
    expect(await chat("google/x", "hi", usage)).toBe('{"a":1}');
    expect(usage).toEqual({ calls: 2, prompt_tokens: 20, completion_tokens: 10, cost: 0.5 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer sk-or-x");
    expect(JSON.parse(init.body)).toMatchObject({ model: "google/x", messages: [{ role: "user", content: "hi" }] });
  });

  it("throws on HTTP errors and without a key", async () => {
    await expect(chat("google/x", "hi", emptyUsage())).rejects.toThrow("OPENROUTER_API_KEY");
    process.env.OPENROUTER_API_KEY = "sk-or-x";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("no", { status: 402 })));
    await expect(chat("google/x", "hi", emptyUsage())).rejects.toThrow("OpenRouter HTTP 402");
  });

  it("tolerates a response with no choices or usage", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-x";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
    const usage = emptyUsage();
    expect(await chat("google/x", "hi", usage)).toBe("");
    expect(usage.calls).toBe(1);
  });
});

describe("parseJsonObject", () => {
  it.each([
    ['{"picked":[1]}', { picked: [1] }],
    ['Sure!\n```json\n{"picked":[2],"reason":"x"}\n```', { picked: [2], reason: "x" }],
    ["no json here", undefined],
    ["{not json}", undefined],
    ["[1,2]", undefined],
  ])("%s", (text, expected) => {
    expect(parseJsonObject(text)).toEqual(expected);
  });
});

describe("resolveModel for research stages", () => {
  it("uses the stored id, then the env value, then the fallback", () => {
    expect(resolveModel("a/b", "c/d", "e/f")).toBe("a/b");
    expect(resolveModel(undefined, "c/d", "e/f")).toBe("c/d");
    expect(resolveModel(undefined, undefined, "e/f")).toBe("e/f");
  });
});
