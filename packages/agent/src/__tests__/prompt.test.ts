import { afterEach, describe, expect, it } from "vitest";
import { buildPrompt, buildSystemPrompt, defaultSystemPrompt, DEFAULT_USER_PROMPT_TEMPLATE, NO_REPLY_SENTINEL } from "../prompt.js";
import { getUserDocs } from "../user-docs.js";
import type { SlackMessage } from "../prompt.js";

describe("buildSystemPrompt", () => {
  it("mentions key data sources", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Google Drive");
    expect(prompt).toContain("GitHub");
    expect(prompt).toContain("URL Fetcher");
  });

  it("includes character limit guidance", () => {
    expect(buildSystemPrompt()).toContain("3900");
  });

  it("uses the override as the base when provided", () => {
    const result = buildSystemPrompt("custom prompt");
    expect(result).toContain("custom prompt");
  });

  it("uses the default base when override is undefined", () => {
    expect(buildSystemPrompt(undefined)).toContain(defaultSystemPrompt());
  });

  it("embeds the system prompt text verbatim for self-reporting", () => {
    const result = buildSystemPrompt("my system prompt");
    expect(result).toContain("System prompt: my system prompt");
  });

  it("embeds the user template verbatim for self-reporting", () => {
    const result = buildSystemPrompt(undefined, "my template {{context}} {{message}}");
    expect(result).toContain("User prompt template: my template {{context}} {{message}}");
  });

  it("uses the default user template when none provided", () => {
    const result = buildSystemPrompt();
    expect(result).toContain(`User prompt template: ${DEFAULT_USER_PROMPT_TEMPLATE}`);
  });

  it("instructs the agent to share prompts if asked", () => {
    expect(buildSystemPrompt()).toContain("share them verbatim");
  });

  it("includes user documentation", () => {
    const result = buildSystemPrompt();
    expect(result).toContain(getUserDocs());
  });

  it("does not include discretion instructions by default", () => {
    expect(buildSystemPrompt()).not.toContain(NO_REPLY_SENTINEL);
  });

  it("includes discretion instructions and sentinel when requiresDiscretion is true", () => {
    const result = buildSystemPrompt(undefined, undefined, { requiresDiscretion: true });
    expect(result).toContain(NO_REPLY_SENTINEL);
    expect(result).toContain("Reply discretion");
  });

  it("does not include discretion instructions when requiresDiscretion is false", () => {
    const result = buildSystemPrompt(undefined, undefined, { requiresDiscretion: false });
    expect(result).not.toContain(NO_REPLY_SENTINEL);
  });
});

describe("getUserDocs", () => {
  it("includes how to interact with the bot", () => {
    const docs = getUserDocs();
    expect(docs).toContain("direct message");
    expect(docs).toContain("thread");
  });

  it("describes what the bot can and cannot do", () => {
    const docs = getUserDocs();
    expect(docs).toContain("Google Drive");
    expect(docs).toContain("cannot");
  });

  it("returns a non-empty string", () => {
    expect(getUserDocs().length).toBeGreaterThan(100);
  });
});

describe("buildPrompt", () => {
  it("returns just the current text when history is empty", () => {
    expect(buildPrompt([], "hello")).toBe("hello");
  });

  it("returns just the current text when history has only the current message", () => {
    const history: SlackMessage[] = [{ user: "U1", text: "hello" }];
    expect(buildPrompt(history, "hello")).toBe("hello");
  });

  it("prefixes thread context when there is prior history", () => {
    const history: SlackMessage[] = [
      { user: "U1", text: "first message" },
      { bot_id: "B1", text: "bot reply" },
      { user: "U1", text: "current message" },
    ];
    const result = buildPrompt(history, "current message");
    expect(result).toContain("Thread context:");
    expect(result).toContain("first message");
    expect(result).toContain("Squirrel");
    expect(result).toContain("Current message:");
    expect(result).toContain("current message");
  });

  it("excludes the last history item (current message) from context", () => {
    const history: SlackMessage[] = [
      { user: "U1", text: "earlier" },
      { user: "U1", text: "this is the current one" },
    ];
    const result = buildPrompt(history, "this is the current one");
    expect(result).toContain("earlier");
    const occurrences = result.split("this is the current one").length - 1;
    expect(occurrences).toBe(1);
  });

  it("labels bot messages as Squirrel", () => {
    const history: SlackMessage[] = [
      { bot_id: "B1", text: "I found the document." },
      { user: "U1", text: "thanks" },
    ];
    const result = buildPrompt(history, "thanks");
    expect(result).toContain("Squirrel: I found the document.");
  });

  it("labels user messages with their user ID", () => {
    const history: SlackMessage[] = [
      { user: "U_ALICE", text: "find the Q4 report" },
      { user: "U_ALICE", text: "current" },
    ];
    const result = buildPrompt(history, "current");
    expect(result).toContain("U_ALICE");
  });

  it("handles messages with no user or bot_id", () => {
    const history: SlackMessage[] = [
      { text: "mystery message" },
      { user: "U1", text: "current" },
    ];
    expect(() => buildPrompt(history, "current")).not.toThrow();
  });

  it("uses a custom template when provided", () => {
    const history: SlackMessage[] = [
      { user: "U1", text: "prior" },
      { user: "U1", text: "current" },
    ];
    const result = buildPrompt(history, "current", "CTX:{{context}} MSG:{{message}}");
    expect(result).toContain("CTX:");
    expect(result).toContain("MSG:current");
    expect(result).toContain("prior");
  });

  it("falls back to default template when undefined", () => {
    const history: SlackMessage[] = [
      { user: "U1", text: "prior" },
      { user: "U1", text: "current" },
    ];
    expect(buildPrompt(history, "current", undefined)).toContain("Thread context:");
  });

  it("DEFAULT_USER_PROMPT_TEMPLATE contains both placeholders", () => {
    expect(DEFAULT_USER_PROMPT_TEMPLATE).toContain("{{context}}");
    expect(DEFAULT_USER_PROMPT_TEMPLATE).toContain("{{message}}");
  });

  it("prepends channel context when provided", () => {
    const history: SlackMessage[] = [
      { user: "U1", text: "thread reply" },
      { user: "U1", text: "current" },
    ];
    const channelContext: SlackMessage[] = [
      { user: "U2", text: "channel msg 1" },
      { user: "U3", text: "channel msg 2" },
    ];
    const result = buildPrompt(history, "current", undefined, channelContext);
    expect(result).toContain("Recent channel activity:");
    expect(result).toContain("channel msg 1");
    expect(result).toContain("channel msg 2");
    expect(result.indexOf("Recent channel activity:")).toBeLessThan(result.indexOf("Thread context:"));
  });

  it("omits channel context section when channelContext is empty", () => {
    const history: SlackMessage[] = [
      { user: "U1", text: "prior" },
      { user: "U1", text: "current" },
    ];
    expect(buildPrompt(history, "current", undefined, [])).not.toContain("Recent channel activity:");
  });

  it("returns just current text when no history and no channel context", () => {
    expect(buildPrompt([], "hello", undefined, [])).toBe("hello");
  });

  it("includes channel context even when thread history is minimal", () => {
    const channelContext: SlackMessage[] = [{ user: "U2", text: "bg noise" }];
    const result = buildPrompt([{ user: "U1", text: "current" }], "current", undefined, channelContext);
    expect(result).toContain("Recent channel activity:");
    expect(result).toContain("bg noise");
  });

  it("inserts text containing $& and $1 literally", () => {
    const history = [{ user: "U1", text: "cost is $& or $1" }, { user: "U1", text: "now" }];
    const result = buildPrompt(history, "price $' and $`");
    expect(result).toContain("cost is $& or $1");
    expect(result).toContain("price $' and $`");
  });
});

describe("defaultSystemPrompt version line", () => {
  afterEach(() => {
    delete process.env.DEPLOY_TAG;
    delete process.env.GIT_SHA;
  });

  it("includes DEPLOY_TAG in prompt when set", () => {
    process.env.DEPLOY_TAG = "prod-20260410-abcdef12";
    expect(defaultSystemPrompt()).toContain("prod-20260410-abcdef12");
  });

  it("falls back to GIT_SHA slice when only GIT_SHA is set", () => {
    process.env.GIT_SHA = "abcdef1234567890abcdef1234567890abcdef12";
    expect(defaultSystemPrompt()).toContain("abcdef12");
  });

  it("omits version line when neither env var is set", () => {
    expect(defaultSystemPrompt()).not.toContain("running version");
  });
});
