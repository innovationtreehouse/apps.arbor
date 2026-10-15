import {
  SOCIAL_ACTION_PREFIX,
  type AuditStore,
  type ConfigStore,
  type NewAuditRecord,
  type SocialPost,
  type SocialPostAction,
  type SocialPostEdited,
  type SocialPostMessage,
  type SocialPostPatch,
  type SocialPostProposed,
  type SocialPostStore,
} from "@arbor/db";
import { postMessage, postMessageBlocks, updateMessage, type Block } from "./slack.js";
import { runAgent } from "./agent.js";
import { buildSocialReviewPrompt, checkPlatformLimits } from "./social-review.js";

interface Deps {
  socialPostStore: SocialPostStore;
  configStore: ConfigStore;
  auditStore: AuditStore;
}

const NEAR_WINDOW_MS = 2 * 60 * 60 * 1000;
const SYSTEM_PROMPT =
  "You are Squirrel, reviewing a draft social media post before an approver signs off. " +
  "Check it against the platform limits, the brand voice in the Google Drive social style guide " +
  "(use your Drive tools to read it), risk flags, and nearby scheduled posts. " +
  "Reply with a concise Slack-formatted review. Start with a line `VERDICT: OK`, `VERDICT: REVISE` " +
  "or `VERDICT: BLOCK`, then specific suggested fixes.";
const STALE = "This post changed since you loaded it, re-check the card.";

const STATUS_EMOJI: Record<SocialPost["status"], string> = {
  pending_review: "⏳",
  in_review: "👀",
  approved: "✅",
  objected: "🛑",
  posted: "📣",
  pull_requested: "🚨",
  pulled: "🚫",
  withdrawn: "🗑️",
};
// Statuses where the post is still a proposal (reviewable, editable, withdrawable).
const PROPOSAL: SocialPost["status"][] = ["pending_review", "in_review", "objected", "approved"];

const approvers = () =>
  (process.env.SOCIAL_APPROVER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const clip = (s: string) => (s.length > 2900 ? s.slice(0, 2899) + "…" : s);
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function processSocialPostMessage(msg: SocialPostMessage, deps: Deps): Promise<void> {
  console.log("[social]", msg.type, (msg as any).post_id ?? "", (msg as any).user_id ?? "");
  switch (msg.type) {
    case "social_post_proposed":
      return handleProposed(msg, deps);
    case "social_post_edited":
      return handleEdited(msg, deps);
    case "social_post_action":
      return handleAction(msg, deps);
    case "social_post_nudge":
      return handleNudge(deps);
  }
}

async function handleProposed(msg: SocialPostProposed, deps: Deps): Promise<void> {
  const channel = process.env.SOCIAL_APPROVALS_CHANNEL;
  const missing = !channel ? "SOCIAL_APPROVALS_CHANNEL is unset" : !approvers().length ? "SOCIAL_APPROVER_IDS is empty" : "";
  if (missing) {
    await respond(msg.response_url, `Social posting isn't configured: ${missing}. Ask an admin.`);
    throw new Error(missing);
  }
  const created = await deps.socialPostStore.create({
    platform: msg.platform,
    content: msg.content,
    media_url: msg.media_url,
    scheduled_at: msg.scheduled_at,
    proposer_id: msg.proposer_id,
    slack_view_id: msg.view_id,
  });
  if (created.thread_ts) return; // replayed submission, already posted
  try {
    const { text, record } = await review(created, deps);
    const draft = { ...created, status: "in_review" as const, review: text };
    const thread_ts = await postMessageBlocks(channel!, renderBlocks(draft), summary(draft));
    const saved = await deps.socialPostStore.update(
      created.id, { status: "in_review", review: text, channel, thread_ts }, created.updated_at
    );
    if (!saved) throw new Error("post changed while it was being proposed");
    // Card buttons must carry the saved version, not the pre-insert one.
    await updateMessage(channel!, thread_ts, renderBlocks(saved), summary(saved));
    await audit(deps, { ...record, channel: channel!, thread_ts, user_id: msg.proposer_id });
  } catch (err) {
    await deps.socialPostStore.update(created.id, { status: "withdrawn" }).catch(() => undefined);
    await respond(msg.response_url, `Couldn't post your proposal for review: ${errMsg(err)}`);
    throw err;
  }
  await respond(msg.response_url, `Proposed, see <#${channel}>.`);
}

async function handleEdited(msg: SocialPostEdited, deps: Deps): Promise<void> {
  const post = await deps.socialPostStore.get(msg.post_id);
  if (!post?.channel || !post.thread_ts) return respond(msg.response_url, "Post not found.");
  if (msg.version !== post.updated_at) return respond(msg.response_url, STALE);
  if (msg.user_id !== post.proposer_id) return respond(msg.response_url, "Only the proposer can edit this post.");
  if (!PROPOSAL.includes(post.status)) return respond(msg.response_url, `This post is already ${post.status}.`);
  const edited = await transition(deps, post, msg.user_id, "edit", msg.response_url, {
    platform: msg.platform,
    content: msg.content,
    media_url: msg.media_url,
    scheduled_at: msg.scheduled_at,
    status: post.objected_by ? "objected" : "in_review",
    approved_by: null,
    nudged_at: null,
  });
  if (!edited) return;
  const { text, record } = await review(edited, deps);
  // Only touches `review`, so no version check: a concurrent action's fields survive.
  const updated = (await deps.socialPostStore.update(post.id, { review: text }))!;
  await updateMessage(post.channel, post.thread_ts, renderBlocks(updated), summary(updated));
  await postMessage(post.channel, post.thread_ts, `Edited by <@${msg.user_id}>, review re-run.`);
  await audit(deps, { ...record, channel: post.channel, thread_ts: post.thread_ts, user_id: msg.user_id });
}

async function handleAction(msg: SocialPostAction, deps: Deps): Promise<void> {
  const post = await deps.socialPostStore.get(msg.post_id);
  if (!post?.channel || !post.thread_ts) return respond(msg.response_url, "Post not found.");
  if (msg.version !== post.updated_at) return respond(msg.response_url, STALE);
  const { action, user_id: user } = msg;
  const isApprover = approvers().includes(user);
  const allowed = action === "withdraw" || action === "request_pull" ? isApprover || user === post.proposer_id : isApprover;
  if (!allowed) return respond(msg.response_url, "You're not authorized to do that.");
  if (action === "approve" && user === post.proposer_id) return respond(msg.response_url, "You can't approve your own post.");

  const from: Record<SocialPostAction["action"], SocialPost["status"][]> = {
    approve: PROPOSAL, object: PROPOSAL, clear_objection: PROPOSAL, withdraw: PROPOSAL,
    mark_posted: ["approved"], request_pull: ["posted"], mark_pulled: ["pull_requested"],
  };
  if (!from[action].includes(post.status)) {
    return respond(msg.response_url, `Can't ${action.replace("_", " ")} a post that is ${post.status.replace("_", " ")}.`);
  }
  const reason = msg.reason?.trim();
  if (action === "request_pull" && !reason) return respond(msg.response_url, "A reason is required to request a pull.");

  const now = new Date().toISOString();
  let patch: SocialPostPatch;
  let line: string;
  switch (action) {
    case "approve":
      patch = { approved_by: user, status: post.objected_by ? "objected" : "approved" };
      line = `✅ Approved by <@${user}>.`;
      break;
    case "object":
      patch = { objected_by: user, status: "objected" };
      line = `🛑 Objection raised by <@${user}>.`;
      break;
    case "clear_objection":
      patch = { objected_by: null, status: post.approved_by ? "approved" : "in_review" };
      line = `Objection cleared by <@${user}>.`;
      break;
    case "mark_posted":
      patch = { status: "posted", posted_by: user, posted_at: now };
      line = `📣 Marked posted by <@${user}>.`;
      break;
    case "withdraw":
      patch = { status: "withdrawn" };
      line = `Withdrawn by <@${user}>.`;
      break;
    case "request_pull":
      patch = { status: "pull_requested", pull_reason: reason!, pull_requested_by: user };
      line = `🚨 Pull requested by <@${user}>: ${esc(reason!)} — ${approvers().map((id) => `<@${id}>`).join(" ")}`;
      break;
    case "mark_pulled":
      patch = { status: "pulled", pulled_by: user, pulled_at: now };
      line = `🚫 Marked pulled by <@${user}>.`;
      break;
  }

  const updated = await transition(deps, post, user, action, msg.response_url, patch);
  if (!updated) return;
  await updateMessage(post.channel, post.thread_ts, renderBlocks(updated), summary(updated));
  await postMessage(post.channel, post.thread_ts, line);
}

async function handleNudge(deps: Deps): Promise<void> {
  const tags = approvers().map((id) => `<@${id}>`).join(" ");
  const now = new Date().toISOString();
  for (const post of await deps.socialPostStore.listDueForNudge(now)) {
    if (!post.channel || !post.thread_ts) continue;
    try {
      // Claim first: a concurrent nudge or action makes this undefined and we skip.
      const claimed = await deps.socialPostStore.update(post.id, { nudged_at: now }, post.updated_at);
      if (!claimed) continue;
      // The claim bumped the version; re-render so the card's buttons aren't stale.
      await updateMessage(post.channel, post.thread_ts, renderBlocks(claimed), summary(claimed));
      await postMessage(post.channel, post.thread_ts, `Scheduled time passed, ready to post: ${tags}`);
    } catch (err) {
      console.error(`[social] nudge for #${post.id} failed:`, err);
    }
  }
}

// Conditional update + audit; undefined (after telling the user) when the post moved under us.
async function transition(
  deps: Deps, post: SocialPost, user: string, action: string, responseUrl: string, patch: SocialPostPatch
): Promise<SocialPost | undefined> {
  const updated = await deps.socialPostStore.update(post.id, patch, post.updated_at);
  if (!updated) {
    await respond(responseUrl, STALE);
    return undefined;
  }
  await audit(deps, {
    channel: post.channel!, thread_ts: post.thread_ts!, user_id: user,
    prompt: `social_post:${action} #${post.id}`, response: `${post.status} → ${updated.status}`,
    model: null, duration_ms: 0,
  });
  return updated;
}

async function review(
  post: SocialPost,
  deps: Deps
): Promise<{ text: string; record: Omit<NewAuditRecord, "channel" | "thread_ts" | "user_id"> }> {
  const violations = checkPlatformLimits(post);
  const nearby = (await deps.socialPostStore.listNear(post.platform, post.scheduled_at, NEAR_WINDOW_MS))
    .filter((p) => p.id !== post.id);
  const prompt = buildSocialReviewPrompt(post, nearby);
  const [model, rawLimit] = await Promise.all([
    deps.configStore.get("model").catch(() => undefined),
    deps.configStore.get("token_limit:default").catch(() => undefined),
  ]);
  const maxTokens = rawLimit && parseInt(rawLimit, 10) > 0 ? parseInt(rawLimit, 10) : undefined;
  const start = Date.now();
  // A failed review must not strand the proposal: approvers still see it, with the error.
  const response = await runAgent(prompt, SYSTEM_PROMPT, model, maxTokens).catch(
    (err) => `_Agent review failed: ${errMsg(err)}_`
  );
  const text = violations.length
    ? `*Platform limit violations:*\n${violations.map((v) => `• ${v}`).join("\n")}\n\n${response}`
    : response;
  return { text, record: { prompt, response, model: model ?? null, duration_ms: Date.now() - start } };
}

// Same swallow-on-failure semantics as @arbor/logger's createAuditLogger.
async function audit(deps: Deps, record: NewAuditRecord): Promise<void> {
  await deps.auditStore.write(record).catch((err) => console.error("[audit] write failed:", err));
}

async function respond(responseUrl: string, text: string): Promise<void> {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", text }),
    signal: AbortSignal.timeout(9_000),
  });
}

function summary(post: SocialPost): string {
  return `${post.platform} post proposed by <@${post.proposer_id}> (${post.status})`;
}

const button = (post: SocialPost, action: string, label: string, style?: "primary" | "danger") => ({
  type: "button",
  text: { type: "plain_text", text: label },
  action_id: SOCIAL_ACTION_PREFIX + action,
  value: `${post.id}:${post.updated_at}`,
  ...(style && { style }),
});

export function renderBlocks(post: SocialPost): Block[] {
  const unix = Math.floor(new Date(post.scheduled_at).getTime() / 1000);
  const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text: clip(text) } });
  const verdict = post.review?.match(/^VERDICT: (OK|REVISE|BLOCK)\b/m)?.[1];
  const content = esc(post.content);
  const blocks: Block[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${STATUS_EMOJI[post.status]} ${post.platform} post: ${post.status.replace("_", " ")} · review: ${verdict ?? "none"}`,
      },
    },
    section(
      `Proposed by <@${post.proposer_id}> for <!date^${unix}^{date_short_pretty} at {time}|${post.scheduled_at}>` +
        (post.media_url ? `\nMedia: <${esc(post.media_url)}|Drive link>` : "")
    ),
    section(content),
  ];
  if (post.review) blocks.push({ type: "divider" }, section(`*Review*\n${esc(post.review)}`));
  if (post.status === "pull_requested") {
    blocks.push(section(`*Pull requested* by <@${post.pull_requested_by}>: ${esc(post.pull_reason ?? "")}`));
  }

  const buttons =
    post.status === "approved"
      ? [
          button(post, "mark_posted", "Mark posted", "primary"),
          button(post, "object", "Object", "danger"),
          button(post, "edit", "Edit"),
          button(post, "withdraw", "Withdraw"),
        ]
      : post.status === "in_review" || post.status === "objected"
        ? [
            button(post, "approve", "Approve", "primary"),
            post.objected_by
              ? button(post, "clear_objection", "Clear objection")
              : button(post, "object", "Object", "danger"),
            button(post, "edit", "Edit"),
            button(post, "withdraw", "Withdraw"),
          ]
        : post.status === "posted"
          ? [button(post, "request_pull", "Request pull", "danger")]
          : post.status === "pull_requested"
            ? [button(post, "mark_pulled", "Mark pulled", "primary")]
            : [];
  if (post.status === "approved") {
    blocks.push(section(`*Copy to paste*\n\`\`\`${content.replace(/```/g, "ʼʼʼ")}\`\`\``));
  }
  if (buttons.length) blocks.push({ type: "actions", elements: buttons });
  return blocks;
}
