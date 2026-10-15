import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditStore, ConfigStore, SocialPost, SocialPostStore } from "@arbor/db";

vi.mock("../slack.js", () => ({
  postMessageBlocks: vi.fn().mockResolvedValue("111.222"),
  updateMessage: vi.fn().mockResolvedValue(undefined),
  postMessage: vi.fn().mockResolvedValue(undefined),
  postEphemeral: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../agent.js", () => ({ runAgent: vi.fn().mockResolvedValue("Looks good.") }));
vi.mock("../social-review.js", () => ({
  checkPlatformLimits: vi.fn().mockReturnValue([]),
  buildSocialReviewPrompt: vi.fn().mockReturnValue("review prompt"),
}));

process.env.SOCIAL_APPROVALS_CHANNEL = "C_SOCIAL";
process.env.SOCIAL_APPROVER_IDS = "U_A1,U_A2";

const slack = await import("../slack.js");
const { runAgent } = await import("../agent.js");
const { processSocialPostMessage } = await import("../social-posts.js");

// In-memory fake: only what the module calls.
let rows: SocialPost[];
const store: SocialPostStore = {
  async create(p) {
    const row: SocialPost = {
      ...p, id: rows.length + 1, status: "pending_review", review: null, channel: null, thread_ts: null,
      approved_by: null, objected_by: null, posted_by: null, posted_at: null, nudged_at: null,
      created_at: "", updated_at: "",
    };
    rows.push(row);
    return row;
  },
  async get(id) { return rows.find((r) => r.id === id); },
  async update(id, patch) {
    const row = rows.find((r) => r.id === id)!;
    Object.assign(row, patch);
    return { ...row };
  },
  async listOpen() { return rows; },
  async listNear() { return []; },
  async listDueForNudge(now) {
    return rows.filter((r) => r.status === "approved" && r.scheduled_at < now && !r.nudged_at);
  },
};
const configStore: ConfigStore = { get: vi.fn().mockResolvedValue(undefined), set: vi.fn() };
const auditStore = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AuditStore;
const deps = { socialPostStore: store, configStore, auditStore };

const RESPONSE_URL = "https://hooks.slack.com/test";
const mockFetch = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal("fetch", mockFetch);
const lastResponse = () => JSON.parse(mockFetch.mock.calls.at(-1)![1].body).text as string;

async function propose() {
  await processSocialPostMessage(
    {
      type: "social_post_proposed", platform: "x", content: "Hello world", media_url: null,
      scheduled_at: "2026-01-01T17:00:00.000Z", proposer_id: "U_PROP", response_url: RESPONSE_URL,
    },
    deps
  );
}
const act = (action: "approve" | "object" | "clear_objection" | "mark_posted" | "withdraw", user_id = "U_A1") =>
  processSocialPostMessage({ type: "social_post_action", post_id: 1, action, user_id, response_url: RESPONSE_URL }, deps);

beforeEach(async () => {
  vi.clearAllMocks();
  rows = [];
  await propose();
});

describe("social posts", () => {
  it("proposal reviews, posts root, stores thread and replies ephemerally", async () => {
    expect(runAgent).toHaveBeenCalledWith("review prompt", expect.any(String), undefined, undefined);
    expect(slack.postMessageBlocks).toHaveBeenCalledWith("C_SOCIAL", expect.any(Array), expect.any(String));
    expect(rows[0]).toMatchObject({ status: "in_review", review: "Looks good.", channel: "C_SOCIAL", thread_ts: "111.222" });
    expect(auditStore.write).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: "111.222", user_id: "U_PROP" }));
    expect(lastResponse()).toContain("<#C_SOCIAL>");
  });

  it("approve → approved, with mark_posted button", async () => {
    await act("approve");
    expect(rows[0]).toMatchObject({ status: "approved", approved_by: "U_A1" });
    const blocks = vi.mocked(slack.updateMessage).mock.calls[0][2];
    expect(JSON.stringify(blocks)).toContain("social_post:mark_posted");
    expect(slack.postMessage).toHaveBeenCalledWith("C_SOCIAL", "111.222", expect.stringContaining("<@U_A1>"));
  });

  it("object then approve stays objected; clear_objection → approved", async () => {
    await act("object", "U_A2");
    await act("approve");
    expect(rows[0]).toMatchObject({ status: "objected", approved_by: "U_A1", objected_by: "U_A2" });
    await act("clear_objection", "U_A2");
    expect(rows[0]).toMatchObject({ status: "approved", objected_by: null });
  });

  it("refuses mark_posted unless approved", async () => {
    await act("mark_posted");
    expect(rows[0].status).toBe("in_review");
    expect(lastResponse()).toContain("Only approved");
  });

  it("refuses approve from a non-approver", async () => {
    await act("approve", "U_PROP");
    expect(rows[0].status).toBe("in_review");
    expect(lastResponse()).toContain("not authorized");
  });

  it("edit of a withdrawn post is refused", async () => {
    await act("withdraw", "U_PROP");
    await processSocialPostMessage(
      { type: "social_post_edited", post_id: 1, platform: "x", content: "new", media_url: null,
        scheduled_at: "2026-01-02T17:00:00.000Z", user_id: "U_PROP" },
      deps
    );
    expect(rows[0]).toMatchObject({ status: "withdrawn", content: "Hello world" });
    expect(slack.postEphemeral).toHaveBeenCalledWith("C_SOCIAL", "U_PROP", expect.stringContaining("withdrawn"));
  });

  it("a failed agent review still posts the proposal", async () => {
    vi.mocked(runAgent).mockRejectedValueOnce(new Error("boom"));
    rows = [];
    await propose();
    expect(rows[0]).toMatchObject({ status: "in_review", thread_ts: "111.222" });
    expect(rows[0].review).toContain("boom");
  });

  it("nudge pings approvers once and sets nudged_at", async () => {
    await act("approve");
    await processSocialPostMessage({ type: "social_post_nudge" }, deps);
    expect(rows[0].nudged_at).not.toBeNull();
    expect(slack.postMessage).toHaveBeenLastCalledWith("C_SOCIAL", "111.222", expect.stringContaining("<@U_A1> <@U_A2>"));
    vi.mocked(slack.postMessage).mockClear();
    await processSocialPostMessage({ type: "social_post_nudge" }, deps);
    expect(slack.postMessage).not.toHaveBeenCalled();
  });
});
