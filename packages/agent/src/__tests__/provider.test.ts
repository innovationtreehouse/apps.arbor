import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MODEL, DEFAULT_OPENROUTER_BASE_URL, openRouterBaseUrl, providerEnv, resolveModel } from "../provider.js";

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
