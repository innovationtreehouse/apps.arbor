import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStores, type AuditStore, type ConfigStore, type SocialPostAction, type SocialPostStore } from "@arbor/db";

vi.mock("../slack.js", () => ({
  postMessageBlocks: vi.fn().mockResolvedValue("111.222"),
  updateMessage: vi.fn().mockResolvedValue(undefined),
  postMessage: vi.fn().mockResolvedValue(undefined),
  postEphemeral: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../agent.js", () => ({ runAgent: vi.fn().mockResolvedValue("VERDICT: OK\nLooks good.") }));
vi.mock("../social-review.js", () => ({
  checkPlatformLimits: vi.fn().mockReturnValue([]),
  buildSocialReviewPrompt: vi.fn().mockReturnValue("review prompt"),
}));

process.env.SOCIAL_APPROVALS_CHANNEL = "C_SOCIAL";
process.env.SOCIAL_APPROVER_IDS = "U_A1,U_A2";

const slack = await import("../slack.js");
const { runAgent } = await import("../agent.js");
const { processSocialPostMessage, renderBlocks } = await import("../social-posts.js");

const configStore: ConfigStore = { get: vi.fn().mockResolvedValue(undefined), set: vi.fn() };
const auditStore = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AuditStore;
let dbFile: string;
let store: SocialPostStore;
let deps: { socialPostStore: SocialPostStore; configStore: ConfigStore; auditStore: AuditStore };

const RESPONSE_URL = "https://hooks.slack.com/test";
const mockFetch = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal("fetch", mockFetch);
const lastResponse = () => JSON.parse(mockFetch.mock.calls.at(-1)![1].body).text as string;
const row = async () => (await store.get(1))!;

const propose = (view_id = "V1") =>
  processSocialPostMessage(
    {
      type: "social_post_proposed", view_id, platform: "x", content: "Hello <world> & ```x```", media_url: null,
      scheduled_at: "2026-01-01T17:00:00.000Z", proposer_id: "U_PROP", response_url: RESPONSE_URL,
    },
    deps
  );
// Reads the current version like a fresh card click would, unless one is given.
async function act(action: SocialPostAction["action"], user_id = "U_A1", extra: Partial<SocialPostAction> = {}) {
  const version = extra.version ?? (await row()).updated_at;
  await processSocialPostMessage(
    { type: "social_post_action", post_id: 1, version, action, user_id, response_url: RESPONSE_URL, ...extra },
    deps
  );
  return row();
}
const tick = () => new Promise((r) => setTimeout(r, 2)); // distinct ms-resolution updated_at

beforeEach(async () => {
  vi.clearAllMocks();
  dbFile = path.join(os.tmpdir(), `social-posts-${process.pid}-${Date.now()}-${Math.random()}.db`);
  store = createStores(`file:${dbFile}`).socialPostStore;
  deps = { socialPostStore: store, configStore, auditStore };
  await propose();
  await tick();
});
afterEach(() => fs.rmSync(dbFile, { force: true }));

describe("proposal", () => {
  it("reviews, posts root, stores thread and replies ephemerally", async () => {
    expect(runAgent).toHaveBeenCalledWith("review prompt", expect.any(String), undefined, undefined);
    expect(slack.postMessageBlocks).toHaveBeenCalledWith("C_SOCIAL", expect.any(Array), expect.any(String));
    const post = await row();
    expect(post).toMatchObject({ status: "in_review", channel: "C_SOCIAL", thread_ts: "111.222", slack_view_id: "V1" });
    expect(auditStore.write).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: "111.222", user_id: "U_PROP" }));
    expect(lastResponse()).toContain("<#C_SOCIAL>");
    // The card is re-rendered with the saved version so its buttons aren't born stale.
    const blocks = JSON.stringify(vi.mocked(slack.updateMessage).mock.calls.at(-1)![2]);
    expect(blocks).toContain(`"1:${post.updated_at}"`);
    expect(blocks).toContain("review: OK");
    expect(blocks).toContain("Hello &lt;world&gt; &amp;");
  });

  it("replay of the same view posts nothing twice", async () => {
    vi.clearAllMocks();
    await propose("V1");
    expect(slack.postMessageBlocks).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
    expect(await store.listOpen()).toHaveLength(1);
  });

  it("a failed agent review still posts the proposal", async () => {
    vi.mocked(runAgent).mockRejectedValueOnce(new Error("boom"));
    await propose("V2");
    const post = (await store.get(2))!;
    expect(post).toMatchObject({ status: "in_review", thread_ts: "111.222" });
    expect(post.review).toContain("boom");
  });

  it("a failed Slack post withdraws the row and tells the proposer", async () => {
    vi.mocked(slack.postMessageBlocks).mockRejectedValueOnce(new Error("channel_not_found"));
    await expect(propose("V2")).rejects.toThrow("channel_not_found");
    expect((await store.get(2))!.status).toBe("withdrawn");
    expect(lastResponse()).toBe("Couldn't post your proposal for review: channel_not_found");
  });

  it("refuses before creating anything when no approvers are configured", async () => {
    const saved = process.env.SOCIAL_APPROVER_IDS;
    process.env.SOCIAL_APPROVER_IDS = "";
    try {
      await expect(propose("V2")).rejects.toThrow();
      expect(lastResponse()).toContain("Social posting isn't configured");
      expect(await store.get(2)).toBeUndefined();
    } finally {
      process.env.SOCIAL_APPROVER_IDS = saved;
    }
  });
});

describe("actions", () => {
  it("proposer can't approve their own post", async () => {
    process.env.SOCIAL_APPROVER_IDS = "U_A1,U_A2,U_PROP";
    try {
      expect((await act("approve", "U_PROP")).status).toBe("in_review");
      expect(lastResponse()).toBe("You can't approve your own post.");
    } finally {
      process.env.SOCIAL_APPROVER_IDS = "U_A1,U_A2";
    }
  });

  it("refuses approve from a non-approver", async () => {
    expect((await act("approve", "U_RANDOM")).status).toBe("in_review");
    expect(lastResponse()).toContain("not authorized");
  });

  it("approve → approved, with mark_posted button, and audits the transition", async () => {
    expect(await act("approve")).toMatchObject({ status: "approved", approved_by: "U_A1" });
    const blocks = JSON.stringify(vi.mocked(slack.updateMessage).mock.calls.at(-1)![2]);
    expect(blocks).toContain("social_post:mark_posted");
    expect(blocks).toContain("ʼʼʼxʼʼʼ");
    expect(slack.postMessage).toHaveBeenCalledWith("C_SOCIAL", "111.222", expect.stringContaining("<@U_A1>"));
    expect(auditStore.write).toHaveBeenCalledWith({
      channel: "C_SOCIAL", thread_ts: "111.222", user_id: "U_A1", prompt: "social_post:approve #1",
      response: "in_review → approved", model: null, duration_ms: 0,
    });
  });

  it("object then approve stays objected; any approver clears it → approved", async () => {
    await act("object", "U_A2");
    await tick();
    expect(await act("approve")).toMatchObject({ status: "objected", approved_by: "U_A1", objected_by: "U_A2" });
    await tick();
    expect(await act("clear_objection", "U_A1")).toMatchObject({ status: "approved", objected_by: null });
  });

  it("stale version is refused", async () => {
    const stale = (await row()).updated_at;
    await act("object", "U_A2");
    await tick();
    expect((await act("approve", "U_A1", { version: stale })).status).toBe("objected");
    expect(lastResponse()).toBe("This post changed since you loaded it, re-check the card.");
  });

  it("concurrent approve + object never leaves an approved post with an objection", async () => {
    const version = (await row()).updated_at;
    await Promise.all([act("approve", "U_A1", { version }), act("object", "U_A2", { version })]);
    const post = await row();
    expect(post.status === "approved" && post.objected_by).toBeFalsy();
    const changes = [post.approved_by, post.objected_by].filter(Boolean);
    expect(changes).toHaveLength(1);
  });

  it("refuses mark_posted unless approved", async () => {
    expect((await act("mark_posted")).status).toBe("in_review");
    expect(lastResponse()).toContain("Can't mark posted");
  });

  it("withdraw by an approver closes an orphan", async () => {
    expect((await act("withdraw", "U_A2")).status).toBe("withdrawn");
  });
});

describe("edit", () => {
  const edit = async (user_id = "U_PROP", version?: string) =>
    processSocialPostMessage(
      { type: "social_post_edited", post_id: 1, version: version ?? (await row()).updated_at, platform: "x",
        content: "new", media_url: null, scheduled_at: "2026-01-02T17:00:00.000Z", user_id, response_url: RESPONSE_URL },
      deps
    );

  it("keeps an open objection and clears approval", async () => {
    await act("approve");
    await tick();
    await act("object", "U_A2");
    await tick();
    await edit();
    expect(await row()).toMatchObject({ content: "new", status: "objected", objected_by: "U_A2", approved_by: null });
  });

  it("without objection returns to in_review", async () => {
    await act("approve");
    await tick();
    await edit();
    expect(await row()).toMatchObject({ content: "new", status: "in_review", approved_by: null });
  });

  it("refuses non-proposer, stale version, and terminal posts", async () => {
    await edit("U_A1");
    expect(lastResponse()).toContain("Only the proposer");
    const stale = (await row()).updated_at;
    await act("object", "U_A2");
    await tick();
    await edit("U_PROP", stale);
    expect(lastResponse()).toContain("changed since you loaded it");
    await act("withdraw", "U_PROP");
    await tick();
    await edit();
    expect(await row()).toMatchObject({ status: "withdrawn", content: "Hello <world> & ```x```" });
    expect(lastResponse()).toContain("withdrawn");
  });
});

describe("pull", () => {
  beforeEach(async () => {
    await act("approve");
    await tick();
    await act("mark_posted", "U_A2");
    await tick();
    vi.clearAllMocks();
  });

  it("request_pull needs a reason", async () => {
    expect((await act("request_pull", "U_PROP", { reason: "  " })).status).toBe("posted");
    expect(lastResponse()).toContain("reason is required");
  });

  it("request_pull → pull_requested with an immediate ping; mark_pulled is approver-only", async () => {
    expect(await act("request_pull", "U_PROP", { reason: "typo in <date>" })).toMatchObject({
      status: "pull_requested", pull_reason: "typo in <date>", pull_requested_by: "U_PROP",
    });
    expect(slack.postMessage).toHaveBeenCalledWith(
      "C_SOCIAL", "111.222", "🚨 Pull requested by <@U_PROP>: typo in &lt;date&gt; — <@U_A1> <@U_A2>"
    );
    const blocks = JSON.stringify(vi.mocked(slack.updateMessage).mock.calls.at(-1)![2]);
    expect(blocks).toContain("social_post:mark_pulled");
    await tick();
    expect((await act("mark_pulled", "U_PROP")).status).toBe("pull_requested");
    expect(lastResponse()).toContain("not authorized");
    expect(await act("mark_pulled", "U_A1")).toMatchObject({ status: "pulled", pulled_by: "U_A1" });
    expect(renderBlocks(await row()).some((b) => b.type === "actions")).toBe(false);
  });

  it("mark_pulled refused unless pull_requested; posted is not withdrawable", async () => {
    expect((await act("mark_pulled")).status).toBe("posted");
    expect((await act("withdraw", "U_PROP")).status).toBe("posted");
  });
});

describe("nudge", () => {
  it("sets nudged_at once and a failing post doesn't stop the next one", async () => {
    await act("approve");
    await propose("V2");
    await tick();
    const p2 = (await store.get(2))!;
    await processSocialPostMessage(
      { type: "social_post_action", post_id: 2, version: p2.updated_at, action: "approve", user_id: "U_A1", response_url: RESPONSE_URL },
      deps
    );
    vi.clearAllMocks();
    vi.mocked(slack.postMessage).mockRejectedValueOnce(new Error("slack down"));
    await processSocialPostMessage({ type: "social_post_nudge" }, deps);
    expect(slack.postMessage).toHaveBeenCalledTimes(2);
    expect(slack.postMessage).toHaveBeenLastCalledWith("C_SOCIAL", "111.222", expect.stringContaining("<@U_A1> <@U_A2>"));
    expect((await store.get(1))!.nudged_at).not.toBeNull();
    // Card re-rendered with the post-claim version so Mark posted still works.
    const p1 = (await store.get(1))!;
    const card = vi.mocked(slack.updateMessage).mock.calls.find((c) => c[1] === p1.thread_ts);
    expect(JSON.stringify(card?.[2])).toContain(`1:${p1.updated_at}`);
    expect((await store.get(2))!.nudged_at).not.toBeNull();
    vi.mocked(slack.postMessage).mockClear();
    await processSocialPostMessage({ type: "social_post_nudge" }, deps);
    expect(slack.postMessage).not.toHaveBeenCalled();
  });
});
