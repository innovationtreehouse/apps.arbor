import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type { ConfigStore } from "@arbor/db";

// ---------------------------------------------------------------------------
// Mock @arbor/db and @arbor/logger before importing the module under test
// ---------------------------------------------------------------------------

const mockConfigStore: ConfigStore = {
  get: vi.fn().mockResolvedValue(undefined),
  set: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@arbor/db", () => ({
  PostgresConfigStore: vi.fn().mockImplementation(function () {
    return mockConfigStore;
  }),
  PostgresAuditStore: vi.fn().mockImplementation(function () {
    return {};
  }),
  PostgresUrlStore: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

vi.mock("../admin.js", () => ({
  processAdminCommand: vi.fn().mockResolvedValue(undefined),
}));

const mockAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock("@arbor/logger", () => ({
  createAuditLogger: vi.fn().mockReturnValue({ log: mockAuditLog }),
}));

vi.mock("../slack.js", () => ({
  fetchThreadHistory: vi.fn().mockResolvedValue([]),
  fetchChannelHistory: vi.fn().mockResolvedValue([]),
  fetchSlackImages: vi.fn().mockResolvedValue([]),
  postMessage: vi.fn().mockResolvedValue(undefined),
  postEphemeral: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../agent.js", () => ({
  runAgent: vi.fn().mockResolvedValue("Agent response"),
  agentTimeoutS: () => 240,
}));

vi.mock("../retrieval/answer.js", () => ({
  research: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../prompt.js", () => ({
  buildPrompt: vi.fn().mockReturnValue("built prompt"),
  buildSystemPrompt: vi.fn().mockReturnValue("system prompt"),
  NO_REPLY_SENTINEL: "__NO_REPLY__",
}));

const sqsMock = mockClient(SQSClient);

process.env.DATABASE_URL = "postgres://localhost/test";

const { fetchThreadHistory, fetchChannelHistory, fetchSlackImages, postMessage, postEphemeral } = await import("../slack.js");
const { runAgent } = await import("../agent.js");
const { buildPrompt, buildSystemPrompt } = await import("../prompt.js");
const { processEvent, isAdminCommand, isSlackEvent } = await import("../index.js");
const { research } = await import("../retrieval/answer.js");

const baseEvent = {
  channel: "C_CHAN",
  thread_ts: "1.0",
  event_ts: "1.1",
  user: "U1",
  text: "@Squirrel find the doc",
};

beforeEach(() => {
  sqsMock.reset();
  vi.mocked(fetchThreadHistory).mockClear();
  vi.mocked(fetchChannelHistory).mockClear();
  vi.mocked(postMessage).mockClear();
  vi.mocked(postEphemeral).mockClear();
  vi.mocked(runAgent).mockClear();
  vi.mocked(buildPrompt).mockClear();
  vi.mocked(buildSystemPrompt).mockClear();
  vi.mocked(mockConfigStore.get).mockResolvedValue(undefined);
  mockAuditLog.mockClear();

  process.env.SQS_QUEUE_URL = "https://sqs.test/queue";
  process.env.AWS_REGION = "us-east-1";
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  process.env.DATABASE_URL = "postgres://localhost/test";
});

describe("processEvent", () => {
  it("posts ephemeral searching message before running agent", async () => {
    await processEvent(baseEvent);
    expect(postEphemeral).toHaveBeenCalledWith("C_CHAN", "U1", "_Searching…_");
  });

  it("does not post ephemeral when requires_discretion is true", async () => {
    await processEvent({ ...baseEvent, requires_discretion: true });
    expect(postEphemeral).not.toHaveBeenCalled();
  });

  it("fetches thread history, runs agent, and posts response", async () => {
    const history = [{ user: "U1", text: "earlier message" }];
    vi.mocked(fetchThreadHistory).mockResolvedValueOnce(history);
    vi.mocked(runAgent).mockResolvedValueOnce("Here is your answer.");

    await processEvent(baseEvent);

    expect(fetchThreadHistory).toHaveBeenCalledWith("C_CHAN", "1.0");
    expect(buildPrompt).toHaveBeenCalledWith(history, baseEvent.text, undefined, []);
    expect(buildSystemPrompt).toHaveBeenCalledWith(undefined, undefined, { requiresDiscretion: false });
    expect(runAgent).toHaveBeenCalledWith("built prompt", "system prompt", undefined, undefined, [], expect.any(AbortSignal));
    expect(postMessage).toHaveBeenCalledWith("C_CHAN", "1.0", "Here is your answer.");
  });

  it("passes requiresDiscretion: true to buildSystemPrompt when set on event", async () => {
    await processEvent({ ...baseEvent, requires_discretion: true });
    expect(buildSystemPrompt).toHaveBeenCalledWith(undefined, undefined, { requiresDiscretion: true });
  });

  it("does not post or audit when agent returns the no-reply sentinel", async () => {
    vi.mocked(runAgent).mockResolvedValueOnce("__NO_REPLY__");
    await processEvent({ ...baseEvent, requires_discretion: true });
    expect(postMessage).not.toHaveBeenCalled();
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("passes model from configStore to runAgent", async () => {
    vi.mocked(mockConfigStore.get).mockResolvedValueOnce("claude-opus-4-6");

    await processEvent(baseEvent);

    expect(mockConfigStore.get).toHaveBeenCalledWith("model");
    expect(runAgent).toHaveBeenCalledWith("built prompt", "system prompt", "claude-opus-4-6", undefined, [], expect.any(AbortSignal));
  });

  it("passes the agent response to postMessage", async () => {
    vi.mocked(runAgent).mockResolvedValueOnce("Custom agent answer");
    await processEvent(baseEvent);
    expect(postMessage).toHaveBeenCalledWith("C_CHAN", "1.0", "Custom agent answer");
  });

  it("fetches channel context for thread replies and passes it to buildPrompt", async () => {
    const threadEvent = { ...baseEvent, is_thread: true };
    const channelMsgs = [{ user: "U2", text: "some channel noise" }];
    vi.mocked(fetchChannelHistory).mockResolvedValueOnce(channelMsgs);

    await processEvent(threadEvent);

    expect(fetchChannelHistory).toHaveBeenCalledWith("C_CHAN", 4);
    expect(buildPrompt).toHaveBeenCalledWith(expect.any(Array), baseEvent.text, undefined, channelMsgs);
  });

  it("does not fetch channel context for non-thread events", async () => {
    await processEvent({ ...baseEvent, is_thread: false });
    expect(fetchChannelHistory).not.toHaveBeenCalled();
    expect(buildPrompt).toHaveBeenCalledWith(expect.any(Array), baseEvent.text, undefined, []);
  });

  it("continues without channel context if fetchChannelHistory fails", async () => {
    const threadEvent = { ...baseEvent, is_thread: true };
    vi.mocked(fetchChannelHistory).mockRejectedValueOnce(new Error("no perms"));

    await expect(processEvent(threadEvent)).resolves.not.toThrow();
    expect(buildPrompt).toHaveBeenCalledWith(expect.any(Array), baseEvent.text, undefined, []);
  });

  it("propagates errors from fetchThreadHistory", async () => {
    vi.mocked(fetchThreadHistory).mockRejectedValueOnce(new Error("Slack API error"));
    await expect(processEvent(baseEvent)).rejects.toThrow("Slack API error");
  });

  it("propagates errors from runAgent", async () => {
    vi.mocked(runAgent).mockRejectedValueOnce(new Error("Agent failed"));
    await expect(processEvent(baseEvent)).rejects.toThrow("Agent failed");
  });

  it("writes audit record with channel, user, model, and duration after posting response", async () => {
    vi.mocked(mockConfigStore.get).mockResolvedValueOnce("claude-opus-4-6");
    vi.mocked(runAgent).mockResolvedValueOnce("The answer.");

    await processEvent(baseEvent);

    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C_CHAN",
        thread_ts: "1.0",
        user_id: "U1",
        response: "The answer.",
        model: "claude-opus-4-6",
      })
    );
    expect(typeof mockAuditLog.mock.calls[0][0].duration_ms).toBe("number");
  });

  it("writes audit record with null model when none is configured", async () => {
    await processEvent(baseEvent);
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ model: null })
    );
  });

  // ---------------------------------------------------------------------------
  // Token limits
  // ---------------------------------------------------------------------------

  it("passes channel-specific token limit to runAgent", async () => {
    vi.mocked(mockConfigStore.get).mockImplementation(async (key: string) => {
      if (key === `token_limit:${baseEvent.channel}`) return "2048";
      return undefined;
    });

    await processEvent(baseEvent);

    expect(runAgent).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      undefined,
      2048,
      [],
      expect.any(AbortSignal),
    );
  });

  it("falls back to token_limit:default when no channel limit is set", async () => {
    vi.mocked(mockConfigStore.get).mockImplementation(async (key: string) => {
      if (key === "token_limit:default") return "4096";
      return undefined;
    });

    await processEvent(baseEvent);

    expect(runAgent).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      undefined,
      4096,
      [],
      expect.any(AbortSignal),
    );
  });

  it("channel-specific limit takes precedence over default", async () => {
    vi.mocked(mockConfigStore.get).mockImplementation(async (key: string) => {
      if (key === `token_limit:${baseEvent.channel}`) return "1024";
      if (key === "token_limit:default") return "8192";
      return undefined;
    });

    await processEvent(baseEvent);

    expect(runAgent).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      undefined,
      1024,
      [],
      expect.any(AbortSignal),
    );
  });

  it("passes undefined maxTokens when no limit is configured", async () => {
    vi.mocked(mockConfigStore.get).mockResolvedValue(undefined);

    await processEvent(baseEvent);

    expect(runAgent).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      undefined,
      undefined,
      [],
      expect.any(AbortSignal),
    );
  });

  it("treats a stored limit of 0 as unconfigured (passes undefined)", async () => {
    vi.mocked(mockConfigStore.get).mockImplementation(async (key: string) => {
      if (key === `token_limit:${baseEvent.channel}`) return "0";
      return undefined;
    });

    await processEvent(baseEvent);

    expect(runAgent).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      undefined,
      undefined,
      [],
      expect.any(AbortSignal),
    );
  });

  it("treats a stored negative limit as unconfigured (passes undefined)", async () => {
    vi.mocked(mockConfigStore.get).mockImplementation(async (key: string) => {
      if (key === `token_limit:${baseEvent.channel}`) return "-1";
      return undefined;
    });

    await processEvent(baseEvent);

    expect(runAgent).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      undefined,
      undefined,
      [],
      expect.any(AbortSignal),
    );
  });

  it("fetches images and passes them to runAgent when event has files", async () => {
    const imageData = [{ mediaType: "image/png" as const, data: "base64data" }];
    vi.mocked(fetchSlackImages).mockResolvedValueOnce(imageData);

    await processEvent({
      ...baseEvent,
      files: [{ url_private: "https://files.slack.com/img.png", mimetype: "image/png" }],
    });

    expect(fetchSlackImages).toHaveBeenCalledWith([
      { url_private: "https://files.slack.com/img.png", mimetype: "image/png" },
    ]);
    expect(runAgent).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      undefined,
      undefined,
      imageData,
      expect.any(AbortSignal),
    );
  });

  it("passes empty images when fetchSlackImages fails", async () => {
    vi.mocked(fetchSlackImages).mockRejectedValueOnce(new Error("network error"));

    await processEvent({
      ...baseEvent,
      files: [{ url_private: "https://files.slack.com/img.png", mimetype: "image/png" }],
    });

    expect(runAgent).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      undefined,
      undefined,
      [],
      expect.any(AbortSignal),
    );
  });
});

describe("config fallback", () => {
  it("logs failed config reads and still runs the agent with defaults", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(mockConfigStore.get).mockImplementation(async (key: string) => {
      if (key === "model") throw new Error("db down");
      if (key === "token_limit:default") return "4096";
      return undefined;
    });

    await processEvent(baseEvent);

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0]).toContain("model: Error: db down");
    expect(runAgent).toHaveBeenCalledWith("built prompt", "system prompt", undefined, 4096, [], expect.any(AbortSignal));
    errSpy.mockRestore();
  });
});

describe("SQS message guards", () => {
  const admin = { type: "admin_command", subcommand: "list", args: [], userId: "U1", responseUrl: "https://x" };

  it("accepts a well-formed admin command", () => {
    expect(isAdminCommand(admin)).toBe(true);
  });

  it("rejects admin commands missing fields", () => {
    expect(isAdminCommand({ ...admin, args: "list" })).toBe(false);
    expect(isAdminCommand({ ...admin, responseUrl: undefined })).toBe(false);
    expect(isAdminCommand(null)).toBe(false);
  });

  it("accepts a Slack event and rejects malformed ones", () => {
    expect(isSlackEvent(baseEvent)).toBe(true);
    expect(isSlackEvent({ ...baseEvent, channel: 1 })).toBe(false);
    expect(isSlackEvent({ text: "hi" })).toBe(false);
    expect(isSlackEvent("str")).toBe(false);
    expect(isSlackEvent(null)).toBe(false);
  });
});

describe("processEvent research pre-pass", () => {
  it("appends research evidence to the prompt, passes the stage models, and logs usage", async () => {
    vi.mocked(mockConfigStore.get).mockImplementation(async (key: string) =>
      ({ "model:fetch": "google/flash", "model:decide": "google/decide" } as Record<string, string>)[key]);
    vi.mocked(research).mockResolvedValueOnce({
      context: "\n---evidence---",
      usage: { fetch: { calls: 2, prompt_tokens: 1, completion_tokens: 1, cost: 0 }, decide: { calls: 1, prompt_tokens: 1, completion_tokens: 1, cost: 0 } },
      status: { github: "ok, 1 result" },
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(runAgent).mockResolvedValueOnce("answer");
    await processEvent(baseEvent);
    expect(research).toHaveBeenCalledWith(baseEvent.text, expect.objectContaining({
      fetchModel: "google/flash", decideModel: "google/decide", signal: expect.any(AbortSignal) }));
    expect(vi.mocked(runAgent).mock.calls[0][5]).toBe(vi.mocked(research).mock.calls.at(-1)?.[1].signal);
    expect(vi.mocked(runAgent).mock.calls[0][0]).toBe("built prompt\n---evidence---");
    expect(log.mock.calls.some(([line]) => String(line).startsWith("[usage] ") && String(line).includes('"calls":2'))).toBe(true);
    log.mockRestore();
  });

  it("answers without evidence when research throws", async () => {
    vi.mocked(research).mockRejectedValueOnce(new Error("boom"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(runAgent).mockResolvedValueOnce("answer");
    await processEvent(baseEvent);
    expect(vi.mocked(runAgent).mock.calls[0][0]).toBe("built prompt");
    error.mockRestore();
  });

  it("skips research for discretion events", async () => {
    vi.mocked(research).mockClear();
    vi.mocked(runAgent).mockResolvedValueOnce("__NO_REPLY__");
    await processEvent({ ...baseEvent, requires_discretion: true });
    expect(research).not.toHaveBeenCalled();
  });
});
