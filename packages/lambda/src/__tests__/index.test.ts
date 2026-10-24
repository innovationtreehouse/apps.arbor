import * as crypto from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  ECSClient,
  ListTasksCommand,
  RunTaskCommand,
} from "@aws-sdk/client-ecs";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { UrlStore, ConfigStore, AuditStore } from "@arbor/db";

// ---------------------------------------------------------------------------
// Mock @arbor/db before importing the handler
// ---------------------------------------------------------------------------

const mockStore: UrlStore = {
  listEnabled: vi.fn().mockResolvedValue([]),
  listAll: vi.fn().mockResolvedValue([]),
  upsert: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  count: vi.fn().mockResolvedValue(0),
};

const mockConfigStore: ConfigStore = {
  get: vi.fn().mockResolvedValue(undefined),
  set: vi.fn().mockResolvedValue(undefined),
};

const mockAuditStore: AuditStore = {
  write: vi.fn().mockResolvedValue(undefined),
  listRecent: vi.fn().mockResolvedValue([]),
  listByThread: vi.fn().mockResolvedValue([]),
};

vi.mock("@arbor/db", () => ({
  createStores: vi.fn(() => ({
    urlStore: mockStore,
    configStore: mockConfigStore,
    auditStore: mockAuditStore,
  })),
}));

// Mock the rate limiter so tests control holdoff behaviour
const mockRecordAndCheck = vi.fn().mockResolvedValue(false);
vi.mock("../rate-limiter.js", () => ({
  recordAndCheck: mockRecordAndCheck,
}));

const { handler } = await import("../index.js");

const sqsMock = mockClient(SQSClient);
const ecsMock = mockClient(ECSClient);

const TEST_SECRET = "test-signing-secret";

process.env.SLACK_SIGNING_SECRET = TEST_SECRET;
process.env.SQS_QUEUE_URL = "https://sqs.test/queue";
process.env.ECS_CLUSTER = "arbor-cluster";
process.env.ECS_TASK_FAMILY = "arbor-agent";
process.env.ECS_TASK_DEFINITION = "arbor-agent:1";
process.env.SUBNET_IDS = "subnet-1,subnet-2";
process.env.SECURITY_GROUP_IDS = "sg-1";
process.env.ADMIN_USER_IDS = "U_ADMIN,U_ADMIN2";

function ts(offsetSeconds = 0) {
  return String(Math.floor(Date.now() / 1000) + offsetSeconds);
}

function sign(body: string, timestamp: string, secret = TEST_SECRET) {
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");
  return `v0=${hmac}`;
}

function makeEvent(options: {
  path?: string;
  body?: string;
  timestamp?: string;
  signature?: string;
}) {
  const body = options.body ?? "";
  const timestamp = options.timestamp ?? ts();
  const sig = options.signature ?? sign(body, timestamp);
  return {
    rawPath: options.path ?? "/slack/events",
    body,
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": sig,
    },
  } as any;
}

beforeEach(() => {
  sqsMock.reset();
  ecsMock.reset();
  vi.mocked(mockStore.listAll).mockResolvedValue([]);
  vi.mocked(mockStore.listEnabled).mockResolvedValue([]);
  vi.mocked(mockStore.upsert).mockResolvedValue(undefined);
  vi.mocked(mockStore.delete).mockResolvedValue(undefined);
  vi.mocked(mockStore.count).mockResolvedValue(0);
  vi.mocked(mockConfigStore.get).mockReset().mockResolvedValue(undefined);
  vi.mocked(mockConfigStore.set).mockReset().mockResolvedValue(undefined);
  vi.mocked(mockAuditStore.listRecent).mockReset().mockResolvedValue([]);
  vi.mocked(mockAuditStore.listByThread).mockReset().mockResolvedValue([]);
  mockRecordAndCheck.mockResolvedValue(false);
});

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

describe("signature verification", () => {
  it("rejects a missing / bad signature with 401", async () => {
    const res = await handler(
      makeEvent({ signature: "v0=badhash" }),
      {} as any,
      {} as any
    );
    expect(res?.statusCode).toBe(401);
  });

  it("rejects a stale timestamp (>5 min old)", async () => {
    const body = "{}";
    const staleTs = ts(-400);
    const res = await handler(
      makeEvent({ body, timestamp: staleTs, signature: sign(body, staleTs) }),
      {} as any,
      {} as any
    );
    expect(res?.statusCode).toBe(401);
  });

  it("accepts a valid signature", async () => {
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
    ecsMock.on(RunTaskCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});
    const body = JSON.stringify({ type: "event_callback", event: { type: "app_mention", channel: "C1", ts: "1.0", text: "hi", user: "U1" } });
    const res = await handler(makeEvent({ body }), {} as any, {} as any);
    expect(res?.statusCode).not.toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe("routing", () => {
  it("returns 404 for unknown path", async () => {
    const body = "";
    const res = await handler(
      makeEvent({ path: "/unknown", body }),
      {} as any,
      {} as any
    );
    expect(res?.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// /slack/events — event handler
// ---------------------------------------------------------------------------

describe("/slack/events", () => {
  it("responds to url_verification challenge", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const res = await handler(makeEvent({ body }), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    expect(JSON.parse(res?.body ?? "")).toEqual({ challenge: "abc123" });
  });

  it("ignores non-message event types", async () => {
    const body = JSON.stringify({ type: "event_callback", event: { type: "reaction_added" } });
    const res = await handler(makeEvent({ body }), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    expect(sqsMock.calls()).toHaveLength(0);
  });

  it("ignores message events with a subtype (edits, deletions)", async () => {
    const body = JSON.stringify({ type: "event_callback", event: { type: "message", subtype: "message_changed", channel_type: "channel" } });
    const res = await handler(makeEvent({ body }), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    expect(sqsMock.calls()).toHaveLength(0);
  });

  it("ignores bot messages to prevent self-loops", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      event: { type: "app_mention", bot_id: "B123", channel: "C1", ts: "1.0", text: "hi" },
    });
    const res = await handler(makeEvent({ body }), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    expect(sqsMock.calls()).toHaveLength(0);
  });

  it("forwards app_mention with is_mention:true and requires_discretion:false", async () => {
    ecsMock.on(ListTasksCommand).resolves({ taskArns: ["arn:task:1"] });
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "msg-1" });

    const event = { type: "app_mention", channel: "C1", ts: "1.0", thread_ts: "1.0", text: "@Squirrel hi", user: "U1" };
    const body = JSON.stringify({ type: "event_callback", event });

    await handler(makeEvent({ body }), {} as any, {} as any);

    const sent = JSON.parse(sqsMock.calls()[0].args[0].input.MessageBody!);
    expect(sent.is_mention).toBe(true);
    expect(sent.requires_discretion).toBe(false);
  });

  it("forwards message.channels with is_mention:false and requires_discretion:true (when channel_messages=on)", async () => {
    ecsMock.on(ListTasksCommand).resolves({ taskArns: ["arn:task:1"] });
    sqsMock.on(SendMessageCommand).resolves({});
    vi.mocked(mockConfigStore.get).mockResolvedValueOnce("on"); // channel_messages=on

    const event = { type: "message", channel_type: "channel", channel: "C1", ts: "2.0", text: "anyone know the travel policy?", user: "U1" };
    const body = JSON.stringify({ type: "event_callback", event });

    await handler(makeEvent({ body }), {} as any, {} as any);

    const sent = JSON.parse(sqsMock.calls()[0].args[0].input.MessageBody!);
    expect(sent.is_mention).toBe(false);
    expect(sent.requires_discretion).toBe(true);
  });

  it("forwards message.im with is_mention:false and requires_discretion:false", async () => {
    ecsMock.on(ListTasksCommand).resolves({ taskArns: ["arn:task:1"] });
    sqsMock.on(SendMessageCommand).resolves({});

    const event = { type: "message", channel_type: "im", channel: "D1", ts: "3.0", text: "find the travel policy", user: "U1" };
    const body = JSON.stringify({ type: "event_callback", event });

    await handler(makeEvent({ body }), {} as any, {} as any);

    const sent = JSON.parse(sqsMock.calls()[0].args[0].input.MessageBody!);
    expect(sent.is_mention).toBe(false);
    expect(sent.requires_discretion).toBe(false);
  });

  it("skips channel messages that @mention the bot when BOT_USER_ID is set (app_mention handles those)", async () => {
    process.env.BOT_USER_ID = "U_BOT";
    ecsMock.on(ListTasksCommand).resolves({ taskArns: ["arn:task:1"] });
    sqsMock.on(SendMessageCommand).resolves({});

    const event = { type: "message", channel_type: "channel", channel: "C1", ts: "4.0", text: "<@U_BOT> find something", user: "U1" };
    const body = JSON.stringify({ type: "event_callback", event });

    const res = await handler(makeEvent({ body }), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    expect(sqsMock.calls()).toHaveLength(0);
    delete process.env.BOT_USER_ID;
  });

  it("drops top-level channel messages when channel_messages setting is not 'on'", async () => {
    ecsMock.on(ListTasksCommand).resolves({ taskArns: ["arn:task:1"] });
    sqsMock.on(SendMessageCommand).resolves({});

    const event = { type: "message", channel_type: "channel", channel: "C1", ts: "5.0", text: "anyone know the policy?", user: "U1" };
    const body = JSON.stringify({ type: "event_callback", event });

    const res = await handler(makeEvent({ body }), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    expect(sqsMock.calls()).toHaveLength(0);
  });

  it("forwards top-level channel messages when channel_messages setting is 'on'", async () => {
    ecsMock.on(ListTasksCommand).resolves({ taskArns: ["arn:task:1"] });
    sqsMock.on(SendMessageCommand).resolves({});
    vi.mocked(mockConfigStore.get).mockResolvedValueOnce("on");

    const event = { type: "message", channel_type: "channel", channel: "C1", ts: "6.0", text: "anyone know the policy?", user: "U1" };
    const body = JSON.stringify({ type: "event_callback", event });

    const res = await handler(makeEvent({ body }), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    expect(sqsMock.calls()).toHaveLength(1);
  });

  it("drops thread replies when channel_messages setting is not 'on'", async () => {
    ecsMock.on(ListTasksCommand).resolves({ taskArns: ["arn:task:1"] });
    sqsMock.on(SendMessageCommand).resolves({});
    // channel_messages is off (default) — thread replies are now also gated

    const event = { type: "message", channel_type: "channel", channel: "C1", ts: "7.0", thread_ts: "1.0", text: "following up on this", user: "U1" };
    const body = JSON.stringify({ type: "event_callback", event });

    const res = await handler(makeEvent({ body }), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    expect(sqsMock.calls()).toHaveLength(0);
  });

  it("forwards thread replies with requires_discretion:true when channel_messages is 'on'", async () => {
    ecsMock.on(ListTasksCommand).resolves({ taskArns: ["arn:task:1"] });
    sqsMock.on(SendMessageCommand).resolves({});
    vi.mocked(mockConfigStore.get).mockResolvedValueOnce("on"); // channel_messages=on

    const event = { type: "message", channel_type: "channel", channel: "C1", ts: "7.0", thread_ts: "1.0", text: "following up on this", user: "U1" };
    const body = JSON.stringify({ type: "event_callback", event });

    const res = await handler(makeEvent({ body }), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    expect(sqsMock.calls()).toHaveLength(1);
    const sent = JSON.parse(sqsMock.calls()[0].args[0].input.MessageBody!);
    expect(sent.requires_discretion).toBe(true);
    expect(sent.is_mention).toBe(false);
  });

  it("forwards message.im events to SQS", async () => {
    ecsMock.on(ListTasksCommand).resolves({ taskArns: ["arn:task:1"] });
    sqsMock.on(SendMessageCommand).resolves({});

    const event = { type: "message", channel_type: "im", channel: "D1", ts: "3.0", text: "find the travel policy", user: "U1" };
    const body = JSON.stringify({ type: "event_callback", event });

    const res = await handler(makeEvent({ body }), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    const sent2 = JSON.parse(sqsMock.calls()[0].args[0].input.MessageBody!);
    expect(sent2.channel).toBe("D1");
  });

  it("skips channel messages that @mention the bot when BOT_USER_ID is set", async () => {
    process.env.BOT_USER_ID = "U_BOT";
    ecsMock.on(ListTasksCommand).resolves({ taskArns: ["arn:task:1"] });
    sqsMock.on(SendMessageCommand).resolves({});

    const event = { type: "message", channel_type: "channel", channel: "C1", ts: "4.0", text: "<@U_BOT> find something", user: "U1" };
    const body = JSON.stringify({ type: "event_callback", event });

    const res = await handler(makeEvent({ body }), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    expect(sqsMock.calls()).toHaveLength(0); // app_mention will handle this
    delete process.env.BOT_USER_ID;
  });

  it("starts ECS task when not running, then forwards to SQS", async () => {
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
    ecsMock.on(RunTaskCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "msg-1" });

    const event = { type: "app_mention", channel: "C1", ts: "1.0", text: "@Squirrel hi", user: "U1" };
    const body = JSON.stringify({ type: "event_callback", event });

    const res = await handler(makeEvent({ body }), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    expect(ecsMock.commandCalls(RunTaskCommand)).toHaveLength(1);
    expect(sqsMock.calls()).toHaveLength(1);
  });

  it("uses event.ts as thread_ts when thread_ts is absent", async () => {
    ecsMock.on(ListTasksCommand).resolves({ taskArns: ["arn:1"] });
    sqsMock.on(SendMessageCommand).resolves({});

    const event = { type: "app_mention", channel: "C1", ts: "9.9", text: "hi", user: "U1" };
    const body = JSON.stringify({ type: "event_callback", event });

    await handler(makeEvent({ body }), {} as any, {} as any);

    const sent = JSON.parse(sqsMock.calls()[0].args[0].input.MessageBody!);
    expect(sent.thread_ts).toBe("9.9");
  });
});

// ---------------------------------------------------------------------------
// /slack/commands — admin handler
// ---------------------------------------------------------------------------

describe("/slack/commands", () => {
  function makeCommandEvent(userId: string, text: string, responseUrl = "https://hooks.slack.com/response/test") {
    const body = new URLSearchParams({ user_id: userId, command: "/squirrel-admin", text, response_url: responseUrl }).toString();
    return makeEvent({ path: "/slack/commands", body });
  }

  function enqueuedCommand() {
    const calls = sqsMock.calls().filter((c) => {
      const body = c.args[0].input.MessageBody;
      return body && JSON.parse(body).type === "admin_command";
    });
    return calls.length > 0 ? JSON.parse(calls[calls.length - 1].args[0].input.MessageBody!) : null;
  }

  beforeEach(() => {
    ecsMock.on(ListTasksCommand).resolves({ taskArns: ["arn:task:running"] });
    sqsMock.on(SendMessageCommand).resolves({});
  });

  it("rejects non-admin users", async () => {
    const res = await handler(makeCommandEvent("U_NOBODY", "list"), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    const payload = JSON.parse(res?.body ?? "");
    expect(payload.text).toContain("not authorized");
  });

  it("shows help inline for empty subcommand", async () => {
    const res = await handler(makeCommandEvent("U_ADMIN", ""), {} as any, {} as any);
    const payload = JSON.parse(res?.body ?? "");
    expect(payload.text).toContain("squirrel-admin list");
  });

  it("shows help inline for 'help' subcommand", async () => {
    const res = await handler(makeCommandEvent("U_ADMIN", "help"), {} as any, {} as any);
    const payload = JSON.parse(res?.body ?? "");
    expect(payload.text).toContain("squirrel-admin list");
    expect(payload.text).toContain("audit");
    expect(payload.text).toContain("token-limit");
    expect(payload.text).toContain("model");
  });

  it("acks immediately with 200 and enqueues list command to SQS", async () => {
    const res = await handler(makeCommandEvent("U_ADMIN", "list"), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    expect(res?.body).toBe("");
    const cmd = enqueuedCommand();
    expect(cmd).toMatchObject({ type: "admin_command", subcommand: "list", args: [], userId: "U_ADMIN" });
  });

  it("acks immediately with 200 and enqueues add command to SQS", async () => {
    const res = await handler(makeCommandEvent("U_ADMIN", "add https://docs.example.com Our API docs"), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    expect(res?.body).toBe("");
    const cmd = enqueuedCommand();
    expect(cmd).toMatchObject({ type: "admin_command", subcommand: "add", args: ["https://docs.example.com", "Our", "API", "docs"] });
  });

  it("acks immediately with 200 and enqueues remove command to SQS", async () => {
    const res = await handler(makeCommandEvent("U_ADMIN", "remove https://docs.example.com"), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    const cmd = enqueuedCommand();
    expect(cmd).toMatchObject({ type: "admin_command", subcommand: "remove", args: ["https://docs.example.com"] });
  });

  it("acks immediately with 200 and enqueues test command to SQS", async () => {
    const res = await handler(makeCommandEvent("U_ADMIN", "test https://example.com"), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    const cmd = enqueuedCommand();
    expect(cmd).toMatchObject({ type: "admin_command", subcommand: "test", args: ["https://example.com"] });
  });

  it("acks immediately with 200 and enqueues model command to SQS", async () => {
    const res = await handler(makeCommandEvent("U_ADMIN", "model claude-haiku-4-5-20251001"), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    const cmd = enqueuedCommand();
    expect(cmd).toMatchObject({ type: "admin_command", subcommand: "model", args: ["claude-haiku-4-5-20251001"] });
  });

  it("acks immediately with 200 and enqueues audit command to SQS", async () => {
    const res = await handler(makeCommandEvent("U_ADMIN", "audit 20"), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    const cmd = enqueuedCommand();
    expect(cmd).toMatchObject({ type: "admin_command", subcommand: "audit", args: ["20"] });
  });

  it("acks immediately with 200 and enqueues audit-thread command to SQS", async () => {
    const res = await handler(makeCommandEvent("U_ADMIN", "audit-thread C1 1.0"), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    const cmd = enqueuedCommand();
    expect(cmd).toMatchObject({ type: "admin_command", subcommand: "audit-thread", args: ["C1", "1.0"] });
  });

  it("acks immediately with 200 and enqueues token-limit command to SQS", async () => {
    const res = await handler(makeCommandEvent("U_ADMIN", "token-limit default 4096"), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    const cmd = enqueuedCommand();
    expect(cmd).toMatchObject({ type: "admin_command", subcommand: "token-limit", args: ["default", "4096"] });
  });

  it("includes response_url in the enqueued SQS message", async () => {
    await handler(makeCommandEvent("U_ADMIN", "list", "https://hooks.slack.com/response/abc"), {} as any, {} as any);
    const cmd = enqueuedCommand();
    expect(cmd?.responseUrl).toBe("https://hooks.slack.com/response/abc");
  });

  it("starts the agent if not already running before enqueuing", async () => {
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
    await handler(makeCommandEvent("U_ADMIN", "list"), {} as any, {} as any);
    expect(ecsMock.calls().some((c) => c.args[0].input instanceof Object && "taskDefinition" in c.args[0].input)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting — holdoff flag on SQS messages
// ---------------------------------------------------------------------------

describe("rate limiting", () => {
  function mentionBody(channel = "C1") {
    return JSON.stringify({
      type: "event_callback",
      event: { type: "app_mention", channel, ts: "1.0", thread_ts: "1.0", text: "@Squirrel hi", user: "U1" },
    });
  }

  beforeEach(() => {
    ecsMock.on(ListTasksCommand).resolves({ taskArns: ["arn:task:1"] });
    sqsMock.on(SendMessageCommand).resolves({});
  });

  it("sets holdoff: false on SQS message when below threshold", async () => {
    mockRecordAndCheck.mockResolvedValueOnce(false);
    await handler(makeEvent({ body: mentionBody() }), {} as any, {} as any);
    const sent = JSON.parse(sqsMock.calls()[0].args[0].input.MessageBody!);
    expect(sent.holdoff).toBe(false);
  });

  it("sets holdoff: true on SQS message when rate limiter triggers", async () => {
    mockRecordAndCheck.mockResolvedValueOnce(true);
    await handler(makeEvent({ body: mentionBody() }), {} as any, {} as any);
    const sent = JSON.parse(sqsMock.calls()[0].args[0].input.MessageBody!);
    expect(sent.holdoff).toBe(true);
  });

  it("still enqueues to SQS even when in holdoff", async () => {
    mockRecordAndCheck.mockResolvedValueOnce(true);
    const res = await handler(makeEvent({ body: mentionBody() }), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    expect(sqsMock.calls()).toHaveLength(1);
  });

  it("calls recordAndCheck with the correct channel", async () => {
    await handler(makeEvent({ body: mentionBody("C_SPECIAL") }), {} as any, {} as any);
    expect(mockRecordAndCheck).toHaveBeenCalledWith(mockConfigStore, "C_SPECIAL");
  });
});
