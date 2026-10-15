import * as crypto from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { ECSClient, ListTasksCommand } from "@aws-sdk/client-ecs";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

const mockSocialGet = vi.fn();
const mockListDue = vi.fn();
vi.mock("@arbor/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  PostgresConfigStore: vi.fn().mockImplementation(function () {
    return { get: vi.fn(), set: vi.fn() };
  }),
  PostgresSocialPostStore: vi.fn().mockImplementation(function () {
    return { get: mockSocialGet, listDueForNudge: mockListDue };
  }),
}));
vi.mock("../rate-limiter.js", () => ({
  ChannelRateLimiter: vi.fn().mockImplementation(function () {
    return { recordAndCheck: vi.fn() };
  }),
}));

const { handler } = await import("../index.js");
const sqsMock = mockClient(SQSClient);
const ecsMock = mockClient(ECSClient);
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

process.env.SLACK_SIGNING_SECRET = "secret";
process.env.SQS_QUEUE_URL = "https://sqs.test/queue";
process.env.SLACK_BOT_TOKEN = "xoxb-test";

function slackEvent(path: string, body: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = "v0=" + crypto.createHmac("sha256", "secret").update(`v0:${timestamp}:${body}`).digest("hex");
  return { rawPath: path, body, headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": sig } } as any;
}
const call = (ev: any) => handler(ev, {} as any, {} as any) as Promise<any>;
const interaction = (payload: object) =>
  call(slackEvent("/slack/interactions", new URLSearchParams({ payload: JSON.stringify(payload) }).toString()));
const sent = () => sqsMock.commandCalls(SendMessageCommand).map((c) => JSON.parse(c.args[0].input.MessageBody!));

function submission(fields: { platform: string; content: string; media_url?: string; at: number }, meta: object = { response_url: "https://r" }) {
  return {
    type: "view_submission",
    user: { id: "U1" },
    view: {
      id: "V1",
      callback_id: "social_post_modal",
      private_metadata: JSON.stringify(meta),
      state: {
        values: {
          platform: { platform: { selected_option: { value: fields.platform } } },
          scheduled_at: { scheduled_at: { selected_date_time: fields.at } },
          content: { content: { value: fields.content } },
          media_url: { media_url: { value: fields.media_url ?? null } },
        },
      },
    },
  };
}
const future = Math.floor(Date.now() / 1000) + 3600;

beforeEach(() => {
  sqsMock.reset();
  ecsMock.reset();
  ecsMock.on(ListTasksCommand).resolves({ taskArns: ["arn:task:1"] });
  sqsMock.on(SendMessageCommand).resolves({});
  fetchMock.mockReset().mockResolvedValue({ json: async () => ({ ok: true }) });
  mockSocialGet.mockReset();
  mockListDue.mockReset();
});

describe("social", () => {
  it("/propose-post opens the modal", async () => {
    const body = new URLSearchParams({ command: "/propose-post", user_id: "U1", trigger_id: "T1", response_url: "https://r" }).toString();
    const res = await call(slackEvent("/slack/commands", body));
    expect(res).toMatchObject({ statusCode: 200, body: "" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://slack.com/api/views.open");
    expect(init.headers.Authorization).toBe("Bearer xoxb-test");
    const { trigger_id, view } = JSON.parse(init.body);
    expect(trigger_id).toBe("T1");
    expect(view.callback_id).toBe("social_post_modal");
    expect(JSON.parse(view.private_metadata)).toEqual({ response_url: "https://r" });
    expect(view.blocks.map((b: any) => b.block_id)).toEqual(["platform", "scheduled_at", "content", "media_url"]);
  });

  it("valid submission enqueues social_post_proposed", async () => {
    const res = await interaction(submission({ platform: "x", content: "hello", at: future }));
    expect(res).toMatchObject({ statusCode: 200, body: "" });
    expect(sent()).toEqual([{
      type: "social_post_proposed", view_id: "V1", platform: "x", content: "hello", media_url: null,
      scheduled_at: new Date(future * 1000).toISOString(), proposer_id: "U1", response_url: "https://r",
    }]);
  });

  it("submission with post_id enqueues social_post_edited", async () => {
    await interaction(submission({ platform: "facebook", content: "hi", at: future }, { response_url: "https://r", post_id: 7, version: "v7" }));
    expect(sent()[0]).toMatchObject({ type: "social_post_edited", post_id: 7, version: "v7", user_id: "U1", response_url: "https://r" });
  });

  it("instagram without media returns field errors", async () => {
    const res = await interaction(submission({ platform: "instagram", content: "hi", at: future }));
    expect(JSON.parse(res.body)).toEqual({ response_action: "errors", errors: { media_url: expect.any(String) } });
    expect(sent()).toHaveLength(0);
  });

  it("past time and non-http media are rejected", async () => {
    const res = await interaction(submission({ platform: "x", content: "hi", media_url: "ftp://a", at: 1 }));
    expect(Object.keys(JSON.parse(res.body).errors).sort()).toEqual(["media_url", "scheduled_at"]);
  });

  it("block action enqueues social_post_action", async () => {
    const res = await interaction({
      type: "block_actions", user: { id: "U2" }, response_url: "https://r2",
      actions: [{ action_id: "social_post:approve", value: "42:2026-01-01T00:00:00.000Z" }],
    });
    expect(res.statusCode).toBe(200);
    expect(sent()).toEqual([{
      type: "social_post_action", post_id: 42, version: "2026-01-01T00:00:00.000Z", action: "approve", user_id: "U2", response_url: "https://r2",
    }]);
  });

  it("edit action opens a prefilled modal for the proposer", async () => {
    mockSocialGet.mockResolvedValue({ id: 5, proposer_id: "U1", status: "objected", platform: "x", content: "old", media_url: null, scheduled_at: new Date(future * 1000).toISOString() });
    await interaction({
      type: "block_actions", user: { id: "U1" }, trigger_id: "T2", response_url: "https://r",
      actions: [{ action_id: "social_post:edit", value: "5:v5" }],
    });
    expect(mockSocialGet).toHaveBeenCalledWith(5);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://slack.com/api/views.open");
    const { view } = JSON.parse(init.body);
    expect(JSON.parse(view.private_metadata)).toEqual({ post_id: 5, version: "v5", response_url: "https://r" });
    expect(view.blocks[2].element.initial_value).toBe("old");
    expect(sent()).toHaveLength(0);
  });

  it("edit by a non-proposer or on a posted post posts an ephemeral and opens nothing", async () => {
    const edit = (user: string) => interaction({
      type: "block_actions", user: { id: user }, trigger_id: "T2", response_url: "https://r",
      actions: [{ action_id: "social_post:edit", value: "5:v5" }],
    });
    mockSocialGet.mockResolvedValue({ id: 5, proposer_id: "U1", status: "in_review" });
    await edit("U9");
    mockSocialGet.mockResolvedValue({ id: 5, proposer_id: "U1", status: "posted" });
    await edit("U1");
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["https://r", "https://r"]);
    expect(fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).text)).toEqual(["Only the proposer can edit", "This post is posted"]);
    expect(sent()).toHaveLength(0);
  });

  it("request_pull opens the reason modal and its submission enqueues the action", async () => {
    await interaction({
      type: "block_actions", user: { id: "U3" }, trigger_id: "T3", response_url: "https://r3",
      actions: [{ action_id: "social_post:request_pull", value: "9:v9" }],
    });
    const { view } = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(view.callback_id).toBe("social_pull_modal");
    expect(view.blocks.map((b: any) => b.block_id)).toEqual(["reason"]);
    expect(sent()).toHaveLength(0);

    await interaction({
      type: "view_submission", user: { id: "U3" },
      view: { callback_id: "social_pull_modal", private_metadata: view.private_metadata, state: { values: { reason: { reason: { value: " typo " } } } } },
    });
    expect(sent()).toEqual([{
      type: "social_post_action", action: "request_pull", post_id: 9, version: "v9", user_id: "U3", response_url: "https://r3", reason: "typo",
    }]);
  });

  it("unknown action or garbage value is ignored", async () => {
    for (const a of [{ action_id: "social_post:delete", value: "1:v" }, { action_id: "social_post:approve", value: "42" }, { action_id: "social_post:approve", value: "abc:v" }]) {
      expect((await interaction({ type: "block_actions", user: { id: "U1" }, actions: [a] })).statusCode).toBe(200);
    }
    expect(sent()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("invalid platform is a modal error", async () => {
    const res = await interaction(submission({ platform: "tiktok", content: "hi", at: future }));
    expect(JSON.parse(res.body).errors).toEqual({ platform: expect.any(String) });
  });

  it("views.open failure returns an ephemeral from /propose-post", async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ ok: false, error: "expired_trigger_id" }) });
    const body = new URLSearchParams({ command: "/propose-post", user_id: "U1", trigger_id: "T1", response_url: "https://r" }).toString();
    const res = await call(slackEvent("/slack/commands", body));
    expect(JSON.parse(res.body)).toEqual({ response_type: "ephemeral", text: "Couldn't open the form (expired_trigger_id)" });
  });

  it("EventBridge tick with nothing due touches neither ECS nor SQS", async () => {
    mockListDue.mockResolvedValue([]);
    expect((await call({ source: "aws.events" })).statusCode).toBe(200);
    expect(ecsMock.calls()).toHaveLength(0);
    expect(sqsMock.calls()).toHaveLength(0);
  });

  it("EventBridge tick with due posts enqueues a nudge", async () => {
    mockListDue.mockResolvedValue([{ id: 1 }]);
    await call({ source: "aws.events" });
    expect(sent()).toEqual([{ type: "social_post_nudge" }]);
    expect(ecsMock.commandCalls(ListTasksCommand)).toHaveLength(1);
  });
});
