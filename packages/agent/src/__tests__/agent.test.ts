import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the agent SDK before importing the module under test
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const { runAgent, ALLOWED_TOOLS } = await import("../agent.js");
const { resetDriveStatus } = await import("../retrieval/sources/drive.js");


process.env.AWS_REGION = "us-east-1";
process.env.SLACK_BOT_TOKEN = "xoxb-test";

const savedKey = process.env.OPENROUTER_API_KEY;
const savedBase = process.env.OPENROUTER_BASE_URL;
beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.unstubAllGlobals();
  delete process.env.GDRIVE_MCP_PROXY_URL;
  resetDriveStatus();
  process.env.OPENROUTER_API_KEY = "sk-or-test";
  delete process.env.OPENROUTER_BASE_URL;
});
afterAll(() => {
  if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedKey;
  if (savedBase === undefined) delete process.env.OPENROUTER_BASE_URL;
  else process.env.OPENROUTER_BASE_URL = savedBase;
});

describe("runAgent", () => {
  it("returns the result from a successful query", async () => {
    vi.mocked(query).mockReturnValue(
      (async function* () {
        yield { result: "Here is the document you requested." };
      })()
    );

    const result = await runAgent("find the Q4 report", "You are Squirrel.");
    expect(result).toBe("Here is the document you requested.");
  });

  it("returns fallback message when query yields no result", async () => {
    vi.mocked(query).mockReturnValue(
      (async function* () {
        yield { type: "assistant", content: [] };
      })()
    );

    const result = await runAgent("find something", "system");
    expect(result).toBe("I was unable to generate a response.");
  });

  it("uses the last result when multiple result messages are yielded", async () => {
    vi.mocked(query).mockReturnValue(
      (async function* () {
        yield { result: "first" };
        yield { result: "second" };
      })()
    );

    const result = await runAgent("prompt", "system");
    expect(result).toBe("second");
  });

  it("passes systemPrompt and model to query options", async () => {
    vi.mocked(query).mockReturnValue(
      (async function* () {
        yield { result: "ok" };
      })()
    );
    process.env.MODEL = "anthropic/claude-opus-4.6";

    await runAgent("test prompt", "test system");

    const callArgs = vi.mocked(query).mock.calls[0][0];
    expect(callArgs.prompt).toBe("test prompt");
    expect(callArgs.options?.systemPrompt).toMatch(/^test system\n\nGoogle Drive is not configured/);
    expect(callArgs.options?.model).toBe("anthropic/claude-opus-4.6");
    delete process.env.MODEL;
  });

  it("falls back to the OpenRouter default model when MODEL is not set", async () => {
    delete process.env.MODEL;
    vi.mocked(query).mockReturnValue(
      (async function* () {
        yield { result: "ok" };
      })()
    );

    await runAgent("prompt", "system");

    const callArgs = vi.mocked(query).mock.calls[0][0];
    expect(callArgs.options?.model).toBe("anthropic/claude-opus-4.6");
  });

  it("passes OpenRouter provider env to query", async () => {
    vi.mocked(query).mockReturnValue((async function* () { yield { result: "ok" }; })());
    await runAgent("prompt", "system");
    const env = vi.mocked(query).mock.calls[0][0].options?.env;
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_AUTH_TOKEN: "sk-or-test",
      ANTHROPIC_API_KEY: "",
    });
  });

  it("OPENROUTER_BASE_URL overrides the base URL", async () => {
    process.env.OPENROUTER_BASE_URL = "http://localhost:9999/api";
    vi.mocked(query).mockReturnValue((async function* () { yield { result: "ok" }; })());
    await runAgent("prompt", "system");
    expect(vi.mocked(query).mock.calls[0][0].options?.env?.ANTHROPIC_BASE_URL).toBe("http://localhost:9999/api");
  });

  it("includes gdrive, github, and urlFetcher MCP servers", async () => {
    vi.mocked(query).mockReturnValue(
      (async function* () {
        yield { result: "ok" };
      })()
    );
    process.env.GDRIVE_MCP_PROXY_URL = "http://127.0.0.1:8123/mcp";
    process.env.GITHUB_TOKEN = "ghp_test";
    const health = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", health);

    await runAgent("prompt", "system");

    expect(String(health.mock.calls[0][0])).toBe("http://127.0.0.1:8123/health");
    const { mcpServers, systemPrompt } = vi.mocked(query).mock.calls[0][0].options ?? {};
    expect(mcpServers).toHaveProperty("gdrive");
    expect(mcpServers).toHaveProperty("github");
    expect(mcpServers).toHaveProperty("urlFetcher");
    expect(systemPrompt).toBe("system");
  });

  it("drops the gdrive server and tells the model when the proxy is unhealthy", async () => {
    vi.mocked(query).mockReturnValue((async function* () { yield { result: "ok" }; })());
    process.env.GDRIVE_MCP_PROXY_URL = "http://127.0.0.1:8123/mcp";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("starting", { status: 503 })));

    await runAgent("prompt", "system");

    const { mcpServers, systemPrompt } = vi.mocked(query).mock.calls[0][0].options ?? {};
    expect(mcpServers).not.toHaveProperty("gdrive");
    expect(systemPrompt).toContain("Google Drive is temporarily unavailable");
  });

  it("treats a proxy that refuses connections as unavailable and caches the answer", async () => {
    vi.mocked(query).mockImplementation(async function* () { yield { result: "ok" }; });
    process.env.GDRIVE_MCP_PROXY_URL = "http://127.0.0.1:8123/mcp";
    const health = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", health);

    await runAgent("prompt", "system");
    await runAgent("prompt", "system");

    expect(health).toHaveBeenCalledTimes(1);
    expect(vi.mocked(query).mock.calls[1][0].options?.mcpServers).not.toHaveProperty("gdrive");
  });

  it("stops when the caller's deadline (shared with research) has already passed", async () => {
    vi.mocked(query).mockImplementation(async function* () { yield { result: "late" }; });
    await expect(runAgent("prompt", "system", undefined, undefined, [], AbortSignal.abort())).rejects.toThrow("timed out");
  });

  it("offers no GitHub write tools", () => {
    expect(ALLOWED_TOOLS.filter((t) => /^mcp__github__(create|add|update|merge|push|fork)_/.test(t))).toEqual([]);
  });

  it("logs answer-stage usage from the result message", async () => {
    vi.mocked(query).mockReturnValue((async function* () {
      yield { type: "result", result: "ok", total_cost_usd: 0.12, usage: { input_tokens: 5 } };
    })());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runAgent("prompt", "system");
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[usage] {"stage":"answer","cost":0.12'));
    log.mockRestore();
  });

  it("passes model argument to query, taking priority over MODEL env var", async () => {
    process.env.MODEL = "anthropic/claude-opus-4.6";
    vi.mocked(query).mockReturnValue(
      (async function* () {
        yield { result: "ok" };
      })()
    );

    await runAgent("prompt", "system", "anthropic/claude-haiku-4.5");

    const callArgs = vi.mocked(query).mock.calls[0][0];
    expect(callArgs.options?.model).toBe("anthropic/claude-haiku-4.5");
    delete process.env.MODEL;
  });

  it("retries on error and returns result on success after failures", async () => {
    vi.useFakeTimers();
    vi.mocked(query)
      .mockImplementationOnce(async function* () { throw new Error("MCP timeout"); })
      .mockReturnValue(
        (async function* () {
          yield { result: "recovered" };
        })()
      );

    const resultPromise = runAgent("prompt", "system");
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result).toBe("recovered");
    expect(vi.mocked(query)).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("throws after exhausting all retries", async () => {
    vi.useFakeTimers();
    vi.mocked(query).mockImplementation(async function* () {
      throw new Error("connection timeout");
    });

    const resultPromise = runAgent("prompt", "system");
    // Attach rejection handler before advancing timers to avoid unhandled rejection
    const assertion = expect(resultPromise).rejects.toThrow("connection timeout");
    await vi.runAllTimersAsync();
    await assertion;
    // default MAX_MCP_RETRIES=2 → 3 total attempts
    expect(vi.mocked(query)).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("throws immediately with a clear message when MAX_MCP_RETRIES is negative", async () => {
    process.env.MAX_MCP_RETRIES = "-1";
    // query should never be called — the loop body never executes
    const result = await expect(runAgent("prompt", "system")).rejects.toThrow(
      "runAgent: no attempts made"
    );
    expect(vi.mocked(query)).not.toHaveBeenCalled();
    delete process.env.MAX_MCP_RETRIES;
  });

  it("respects MAX_MCP_RETRIES env var", async () => {
    process.env.MAX_MCP_RETRIES = "0";
    vi.useFakeTimers();
    vi.mocked(query).mockImplementation(async function* () {
      throw new Error("ECONNRESET");
    });

    const resultPromise = runAgent("prompt", "system");
    const assertion = expect(resultPromise).rejects.toThrow("ECONNRESET");
    await vi.runAllTimersAsync();
    await assertion;
    expect(vi.mocked(query)).toHaveBeenCalledTimes(1);
    delete process.env.MAX_MCP_RETRIES;
    vi.useRealTimers();
  });

  it("uses exponential backoff delays: 1s for attempt 1, 2s for attempt 2", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0); // eliminate jitter for exact assertions

    vi.mocked(query).mockImplementation(async function* () {
      throw new Error("socket hang up");
    });

    const resultPromise = runAgent("prompt", "system"); // MAX_MCP_RETRIES=2 default
    const assertion = expect(resultPromise).rejects.toThrow("socket hang up");

    // Flush initial attempt
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(query)).toHaveBeenCalledTimes(1);

    // 999ms — first retry not yet fired
    await vi.advanceTimersByTimeAsync(999);
    expect(vi.mocked(query)).toHaveBeenCalledTimes(1);

    // 1ms more (= 1000ms base, jitter=0) — first retry fires
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(query)).toHaveBeenCalledTimes(2);

    // 1999ms — second retry not yet fired
    await vi.advanceTimersByTimeAsync(1999);
    expect(vi.mocked(query)).toHaveBeenCalledTimes(2);

    // 1ms more (= 2000ms base, jitter=0) — second retry fires
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(query)).toHaveBeenCalledTimes(3);

    await assertion;
    vi.spyOn(Math, "random").mockRestore();
    vi.useRealTimers();
  });

  it("does not retry non-transient errors", async () => {
    vi.useFakeTimers();
    vi.mocked(query).mockImplementation(async function* () {
      throw new Error("authentication_error: invalid credentials");
    });

    const resultPromise = runAgent("prompt", "system");
    const assertion = expect(resultPromise).rejects.toThrow("authentication_error");
    await vi.runAllTimersAsync();
    await assertion;
    // Should fail immediately without retrying
    expect(vi.mocked(query)).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("caps output tokens via CLAUDE_CODE_MAX_OUTPUT_TOKENS when maxTokens is provided", async () => {
    vi.mocked(query).mockReturnValue(
      (async function* () {
        yield { result: "ok" };
      })()
    );

    await runAgent("prompt", "system", undefined, 2048);

    const options = vi.mocked(query).mock.calls[0][0].options;
    expect(options?.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("2048");
    expect(options).not.toHaveProperty("maxTokens");
  });

  it("leaves CLAUDE_CODE_MAX_OUTPUT_TOKENS unset when maxTokens is not provided", async () => {
    vi.mocked(query).mockReturnValue(
      (async function* () {
        yield { result: "ok" };
      })()
    );

    await runAgent("prompt", "system");

    const options = vi.mocked(query).mock.calls[0][0].options;
    expect(options?.env).not.toHaveProperty("CLAUDE_CODE_MAX_OUTPUT_TOKENS");
  });

  it("passes DATABASE_URL to urlFetcher MCP env", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    vi.mocked(query).mockReturnValue(
      (async function* () {
        yield { result: "ok" };
      })()
    );

    await runAgent("prompt", "system");

    const { mcpServers } = vi.mocked(query).mock.calls[0][0].options ?? {};
    expect((mcpServers as any)?.urlFetcher?.env?.DATABASE_URL).toBe("postgres://localhost/test");
    expect((mcpServers as any)?.urlFetcher?.env).not.toHaveProperty("DYNAMODB_TABLE");
  });

  it("passes the tool allowlist as data", async () => {
    vi.mocked(query).mockReturnValue((async function* () { yield { result: "ok" }; })());
    await runAgent("prompt", "system");
    expect(vi.mocked(query).mock.calls[0][0].options?.allowedTools).toEqual(ALLOWED_TOOLS);
  });

  it("sets maxTurns from AGENT_MAX_TURNS with a default of 30", async () => {
    vi.mocked(query).mockImplementation(async function* () { yield { result: "ok" }; });
    await runAgent("prompt", "system");
    process.env.AGENT_MAX_TURNS = "5";
    await runAgent("prompt", "system");
    delete process.env.AGENT_MAX_TURNS;
    expect(vi.mocked(query).mock.calls[0][0].options?.maxTurns).toBe(30);
    expect(vi.mocked(query).mock.calls[1][0].options?.maxTurns).toBe(5);
  });

  it("does not retry errors that only mention sockets or networks", async () => {
    vi.mocked(query).mockImplementation(async function* () {
      throw new Error("network policy denied: socket not permitted");
    });
    await expect(runAgent("prompt", "system")).rejects.toThrow("network policy denied");
    expect(vi.mocked(query)).toHaveBeenCalledTimes(1);
  });

  it("retries rate limits and overload", async () => {
    vi.useFakeTimers();
    vi.mocked(query)
      .mockImplementationOnce(async function* () { throw new Error("429 rate_limit_error"); })
      .mockImplementationOnce(async function* () { throw new Error("529 overloaded_error"); })
      .mockImplementation(async function* () { yield { result: "ok" }; });
    const resultPromise = runAgent("prompt", "system");
    await vi.runAllTimersAsync();
    expect(await resultPromise).toBe("ok");
    expect(vi.mocked(query)).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  // The SDK either throws an AbortError or ends the stream; both must surface as a timeout.
  it.each([
    ["throws", true],
    ["ends the stream", false],
  ])("aborts after AGENT_TIMEOUT_S without retrying when the SDK %s", async (_label, throws) => {
    vi.useFakeTimers();
    process.env.AGENT_TIMEOUT_S = "2";
    vi.mocked(query).mockImplementation(async function* ({ options }) {
      const signal = options!.abortController!.signal;
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
      if (throws) throw new Error("Claude Code process aborted by user");
    });

    const resultPromise = runAgent("prompt", "system");
    const assertion = expect(resultPromise).rejects.toThrow("Agent timed out after 2s");
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(vi.mocked(query)).toHaveBeenCalledTimes(1);
    delete process.env.AGENT_TIMEOUT_S;
    vi.useRealTimers();
  });

  it("falls back to 30 turns when AGENT_MAX_TURNS is not a positive number", async () => {
    vi.mocked(query).mockImplementation(async function* () { yield { result: "ok" }; });
    process.env.AGENT_MAX_TURNS = "lots";
    await runAgent("prompt", "system");
    process.env.AGENT_MAX_TURNS = "0";
    await runAgent("prompt", "system");
    delete process.env.AGENT_MAX_TURNS;
    expect(vi.mocked(query).mock.calls[0][0].options?.maxTurns).toBe(30);
    expect(vi.mocked(query).mock.calls[1][0].options?.maxTurns).toBe(30);
  });

  it("falls back to the 240 s deadline when AGENT_TIMEOUT_S is not a positive number", async () => {
    vi.useFakeTimers();
    process.env.AGENT_TIMEOUT_S = "abc";
    vi.mocked(query).mockImplementation(async function* ({ options }) {
      const signal = options!.abortController!.signal;
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
    });

    const resultPromise = runAgent("prompt", "system");
    const assertion = expect(resultPromise).rejects.toThrow("Agent timed out after 240s");
    await vi.advanceTimersByTimeAsync(239_999);
    expect(vi.mocked(query)).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    delete process.env.AGENT_TIMEOUT_S;
    vi.useRealTimers();
  });
});
