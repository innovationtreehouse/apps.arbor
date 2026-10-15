// Social post approval flow: /propose-post modal, Slack interactions, EventBridge nudge tick.
import {
  PostgresSocialPostStore, SOCIAL_ACTIONS, SOCIAL_ACTION_PREFIX, SOCIAL_MODAL_CALLBACK_ID,
  SOCIAL_PULL_MODAL_CALLBACK_ID, type SocialPost,
} from "@arbor/db";

type Enqueue = (msg: Record<string, unknown>) => Promise<void>;
type Prefill = Partial<Pick<SocialPost, "platform" | "content" | "media_url" | "scheduled_at">>;
type Meta = { response_url: string; post_id?: number; version?: string };

const PLATFORMS = ["instagram", "facebook", "x"];
const EDITABLE = ["in_review", "objected", "approved"];
const BUTTONS: string[] = [...SOCIAL_ACTIONS, "edit"];
let socialPostStore: PostgresSocialPostStore | undefined; // lazy: only Edit and the nudge tick need the DB
const store = () => (socialPostStore ??= new PostgresSocialPostStore(process.env.DATABASE_URL!));
const ok = { statusCode: 200, body: "" };

const option = (p: string) => ({ text: { type: "plain_text", text: p }, value: p });
const input = (block_id: string, label: string, element: object, optional = false) => ({
  type: "input", block_id, optional, label: { type: "plain_text", text: label },
  element: { action_id: block_id, ...element },
});

function modalView(meta: Meta, post: Prefill = {}) {
  return {
    type: "modal",
    callback_id: SOCIAL_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify(meta),
    title: { type: "plain_text", text: meta.post_id ? "Edit post" : "Propose post" },
    submit: { type: "plain_text", text: "Submit" },
    blocks: [
      input("platform", "Platform", {
        type: "static_select", options: PLATFORMS.map(option),
        ...(post.platform ? { initial_option: option(post.platform) } : {}),
      }),
      input("scheduled_at", "Scheduled time", {
        type: "datetimepicker",
        ...(post.scheduled_at ? { initial_date_time: Math.floor(Date.parse(post.scheduled_at) / 1000) } : {}),
      }),
      input("content", "Content", {
        type: "plain_text_input", multiline: true, max_length: 2200,
        ...(post.content ? { initial_value: post.content } : {}),
      }),
      input("media_url", "Media URL (Google Drive link; required for Instagram)", {
        type: "plain_text_input",
        ...(post.media_url ? { initial_value: post.media_url } : {}),
      }, true),
    ],
  };
}

const pullView = (meta: Meta) => ({
  type: "modal",
  callback_id: SOCIAL_PULL_MODAL_CALLBACK_ID,
  private_metadata: JSON.stringify(meta),
  title: { type: "plain_text", text: "Request pull" },
  submit: { type: "plain_text", text: "Submit" },
  blocks: [input("reason", "Why should this post come down?", { type: "plain_text_input", multiline: true })],
});

/** Returns the Slack error string, or undefined on success. */
async function openModal(trigger_id: string, view: object): Promise<string | undefined> {
  const res = await fetch("https://slack.com/api/views.open", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ trigger_id, view }),
  });
  let data: { ok?: boolean; error?: string };
  try { data = (await res.json()) as typeof data; } catch { data = { error: `http_${res.status}` }; }
  if (data.ok) return undefined;
  console.error("views.open failed:", data.error);
  return data.error ?? "unknown_error";
}

async function respond(response_url: string, text: string) {
  await fetch(response_url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }),
  }).catch((err) => console.error("response_url post failed:", err));
}

const cantOpen = (err: string) => `Couldn't open the form (${err})`;

export async function handleProposePost(params: URLSearchParams) {
  const err = await openModal(params.get("trigger_id") ?? "", modalView({ response_url: params.get("response_url") ?? "" }));
  if (!err) return ok;
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", text: cantOpen(err) }),
  };
}

/** EventBridge tick: wake the agent only when an approved post is overdue. */
export async function handleNudgeTick(enqueue: Enqueue) {
  const due = await store().listDueForNudge(new Date().toISOString());
  console.log("[social] nudge tick, due:", due.length);
  if (due.length) await enqueue({ type: "social_post_nudge" });
}

export async function handleInteraction(rawBody: string, enqueue: Enqueue) {
  const payload = JSON.parse(new URLSearchParams(rawBody).get("payload") ?? "{}");
  if (payload.type === "view_submission" && payload.view?.callback_id === SOCIAL_MODAL_CALLBACK_ID) {
    return handleSubmission(payload, enqueue);
  }
  if (payload.type === "view_submission" && payload.view?.callback_id === SOCIAL_PULL_MODAL_CALLBACK_ID) {
    const meta = JSON.parse(payload.view.private_metadata || "{}");
    const reason = (payload.view.state.values.reason?.reason?.value ?? "").trim();
    if (!reason) return viewErrors({ reason: "A reason is required." });
    await enqueue({
      type: "social_post_action", action: "request_pull", post_id: meta.post_id, version: meta.version,
      user_id: payload.user.id, response_url: meta.response_url ?? "", reason,
    });
    return ok;
  }
  if (payload.type !== "block_actions") return ok;

  const act = (payload.actions ?? []).find((a: { action_id?: string }) => a.action_id?.startsWith(SOCIAL_ACTION_PREFIX));
  const action = act?.action_id.slice(SOCIAL_ACTION_PREFIX.length);
  const sep = String(act?.value ?? "").indexOf(":");
  const post_id = Number(String(act?.value).slice(0, sep));
  const version = String(act?.value).slice(sep + 1);
  if (!BUTTONS.includes(action) || sep < 1 || !Number.isInteger(post_id)) return ok; // stale or garbage: ignore
  const user_id = payload.user?.id;
  const response_url = payload.response_url ?? "";
  console.log("[social]", action, post_id, user_id);

  if (action === "request_pull") {
    const err = await openModal(payload.trigger_id, pullView({ post_id, version, response_url }));
    if (err) await respond(response_url, cantOpen(err));
    return ok;
  }
  if (action === "edit") {
    const post = await store().get(post_id);
    const refusal = !post || post.proposer_id !== user_id ? "Only the proposer can edit"
      : !EDITABLE.includes(post.status) ? `This post is ${post.status}` : undefined;
    if (refusal) { await respond(response_url, refusal); return ok; }
    const err = await openModal(payload.trigger_id, modalView({ post_id, version, response_url }, post));
    if (err) await respond(response_url, cantOpen(err));
    return ok;
  }
  await enqueue({ type: "social_post_action", post_id, version, action, user_id, response_url });
  return ok;
}

function viewErrors(errors: Record<string, string>) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_action: "errors", errors }),
  };
}

async function handleSubmission(payload: any, enqueue: Enqueue) {
  const v = payload.view.state.values;
  const platform = v.platform?.platform?.selected_option?.value;
  const content = (v.content?.content?.value ?? "").trim();
  const media_url = (v.media_url?.media_url?.value ?? "").trim() || null;
  const seconds = v.scheduled_at?.scheduled_at?.selected_date_time;

  const errors: Record<string, string> = {};
  if (!PLATFORMS.includes(platform)) errors.platform = "Choose a platform.";
  if (!content) errors.content = "Content is required.";
  if (platform === "instagram" && !media_url) errors.media_url = "Instagram posts require a media URL.";
  if (media_url && !/^https?:\/\//i.test(media_url)) errors.media_url = "Media URL must start with http:// or https://.";
  if (!seconds || seconds * 1000 <= Date.now()) errors.scheduled_at = "Scheduled time must be in the future.";
  if (Object.keys(errors).length) return viewErrors(errors);

  const meta: Meta = JSON.parse(payload.view.private_metadata || "{}");
  const response_url = meta.response_url ?? "";
  const fields = { platform, content, media_url, scheduled_at: new Date(seconds * 1000).toISOString() };
  await enqueue(meta.post_id
    ? { type: "social_post_edited", post_id: meta.post_id, version: meta.version, ...fields, user_id: payload.user.id, response_url }
    : { type: "social_post_proposed", view_id: payload.view.id, ...fields, proposer_id: payload.user.id, response_url });
  return ok;
}
