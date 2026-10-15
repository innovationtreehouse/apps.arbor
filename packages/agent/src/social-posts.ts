import type { AuditStore, ConfigStore, NewAuditRecord, SocialPost, SocialPostStore } from "@arbor/db";
import { postEphemeral, postMessage, postMessageBlocks, updateMessage, type Block } from "./slack.js";
import { runAgent } from "./agent.js";
import { buildSocialReviewPrompt, checkPlatformLimits } from "./social-review.js";
import {
  SOCIAL_ACTION_PREFIX,
  type SocialPostAction,
  type SocialPostEdited,
  type SocialPostMessage,
  type SocialPostProposed,
} from "./social-messages.js";

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
  "Reply with a concise Slack-formatted review: verdict first, then specific suggested fixes.";

const STATUS_EMOJI: Record<SocialPost["status"], string> = {
  pending_review: "⏳",
  in_review: "👀",
  approved: "✅",
  objected: "🛑",
  posted: "📣",
  withdrawn: "🗑️",
};

const approvers = () =>
  (process.env.SOCIAL_APPROVER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const clip = (s: string) => (s.length > 2900 ? s.slice(0, 2899) + "…" : s);

export async function processSocialPostMessage(msg: SocialPostMessage, deps: Deps): Promise<void> {
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
  if (!channel) throw new Error("SOCIAL_APPROVALS_CHANNEL is required");
  const created = await deps.socialPostStore.create({
    platform: msg.platform,
    content: msg.content,
    media_url: msg.media_url,
    scheduled_at: msg.scheduled_at,
    proposer_id: msg.proposer_id,
  });
  const { text, record } = await review(created, deps);
  const draft = { ...created, status: "in_review" as const, review: text };
  const thread_ts = await postMessageBlocks(channel, renderBlocks(draft), summary(draft));
  await deps.socialPostStore.update(created.id, { status: "in_review", review: text, channel, thread_ts });
  await audit(deps, { ...record, channel, thread_ts, user_id: msg.proposer_id });
  await respond(msg.response_url, `Proposed, see <#${channel}>.`);
}

async function handleEdited(msg: SocialPostEdited, deps: Deps): Promise<void> {
  const post = await deps.socialPostStore.get(msg.post_id);
  if (!post?.channel || !post.thread_ts) return;
  if (post.status === "posted" || post.status === "withdrawn") {
    await postEphemeral(post.channel, msg.user_id, `This post is already ${post.status}.`);
    return;
  }
  if (msg.user_id !== post.proposer_id) {
    await postEphemeral(post.channel, msg.user_id, "Only the proposer can edit this post.");
    return;
  }
  const edited = await deps.socialPostStore.update(post.id, {
    platform: msg.platform,
    content: msg.content,
    media_url: msg.media_url,
    scheduled_at: msg.scheduled_at,
    status: "in_review",
    approved_by: null,
    objected_by: null,
    nudged_at: null,
  });
  const { text, record } = await review(edited, deps);
  const updated = await deps.socialPostStore.update(post.id, { review: text });
  await updateMessage(post.channel, post.thread_ts, renderBlocks(updated), summary(updated));
  await postMessage(post.channel, post.thread_ts, `Edited by <@${msg.user_id}>, review re-run.`);
  await audit(deps, { ...record, channel: post.channel, thread_ts: post.thread_ts, user_id: msg.user_id });
}

async function handleAction(msg: SocialPostAction, deps: Deps): Promise<void> {
  const post = await deps.socialPostStore.get(msg.post_id);
  if (!post?.channel || !post.thread_ts) return respond(msg.response_url, "Post not found.");
  const { action, user_id: user } = msg;
  const allowed = action === "withdraw" ? user === post.proposer_id : approvers().includes(user);
  if (!allowed) return respond(msg.response_url, "You're not authorized to do that.");
  if (post.status === "posted" || post.status === "withdrawn") {
    return respond(msg.response_url, `This post is already ${post.status}.`);
  }

  let updated: SocialPost;
  let line: string;
  switch (action) {
    case "approve":
      updated = await deps.socialPostStore.update(post.id, {
        approved_by: user,
        status: post.objected_by ? "objected" : "approved",
      });
      line = `✅ Approved by <@${user}>.`;
      break;
    case "object":
      updated = await deps.socialPostStore.update(post.id, { objected_by: user, status: "objected" });
      line = `🛑 Objection raised by <@${user}>.`;
      break;
    case "clear_objection":
      updated = await deps.socialPostStore.update(post.id, {
        objected_by: null,
        status: post.approved_by ? "approved" : "in_review",
      });
      line = `Objection cleared by <@${user}>.`;
      break;
    case "mark_posted":
      if (post.status !== "approved") return respond(msg.response_url, "Only approved posts can be marked posted.");
      updated = await deps.socialPostStore.update(post.id, {
        status: "posted",
        posted_by: user,
        posted_at: new Date().toISOString(),
      });
      line = `📣 Marked posted by <@${user}>.`;
      break;
    case "withdraw":
      updated = await deps.socialPostStore.update(post.id, { status: "withdrawn" });
      line = `Withdrawn by <@${user}>.`;
      break;
  }
  await updateMessage(post.channel, post.thread_ts, renderBlocks(updated), summary(updated));
  await postMessage(post.channel, post.thread_ts, line);
}

async function handleNudge(deps: Deps): Promise<void> {
  const tags = approvers().map((id) => `<@${id}>`).join(" ");
  for (const post of await deps.socialPostStore.listDueForNudge(new Date().toISOString())) {
    if (!post.channel || !post.thread_ts) continue;
    await postMessage(post.channel, post.thread_ts, `Scheduled time passed, ready to post: ${tags}`);
    await deps.socialPostStore.update(post.id, { nudged_at: new Date().toISOString() });
  }
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
    (err) => `_Agent review failed: ${err instanceof Error ? err.message : String(err)}_`
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
  value: String(post.id),
  ...(style && { style }),
});

export function renderBlocks(post: SocialPost): Block[] {
  const unix = Math.floor(new Date(post.scheduled_at).getTime() / 1000);
  const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text: clip(text) } });
  const blocks: Block[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `${STATUS_EMOJI[post.status]} ${post.platform} post: ${post.status.replace("_", " ")}` },
    },
    section(
      `Proposed by <@${post.proposer_id}> for <!date^${unix}^{date_short_pretty} at {time}|${post.scheduled_at}>` +
        (post.media_url ? `\nMedia: <${post.media_url}|Drive link>` : "")
    ),
    section(post.content),
  ];
  if (post.review) blocks.push({ type: "divider" }, section(`*Review*\n${post.review}`));

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
        : [];
  if (post.status === "approved") blocks.push(section(`*Copy to paste*\n\`\`\`${post.content}\`\`\``));
  if (buttons.length) blocks.push({ type: "actions", elements: buttons });
  return blocks;
}
