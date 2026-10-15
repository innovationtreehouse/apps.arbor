// Social post approval flow: /propose-post modal, Slack interactions, cron nudge.
// Constants and message shapes mirror packages/agent/src/social-messages.ts
// (lambda cannot depend on @arbor/agent).
import { PostgresSocialPostStore, type SocialPost } from "@arbor/db";

export const SOCIAL_MODAL_CALLBACK_ID = "social_post_modal";
export const SOCIAL_ACTION_PREFIX = "social_post:";

type Enqueue = (msg: Record<string, unknown>) => Promise<void>;
type Prefill = Partial<Pick<SocialPost, "platform" | "content" | "media_url" | "scheduled_at">>;

const PLATFORMS = ["instagram", "facebook", "x"];
let socialPostStore: PostgresSocialPostStore | undefined; // lazy: only the Edit button needs the DB
const ok = { statusCode: 200, body: "" };

const option = (p: string) => ({ text: { type: "plain_text", text: p }, value: p });

function modalView(meta: { response_url: string; post_id?: number }, post: Prefill = {}) {
  const input = (block_id: string, label: string, element: object, optional = false) => ({
    type: "input", block_id, optional, label: { type: "plain_text", text: label },
    element: { action_id: block_id, ...element },
  });
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

async function openModal(trigger_id: string, view: object) {
  const res = await fetch("https://slack.com/api/views.open", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ trigger_id, view }),
  });
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) console.error("views.open failed:", data.error);
}

export async function handleProposePost(params: URLSearchParams) {
  await openModal(params.get("trigger_id") ?? "", modalView({ response_url: params.get("response_url") ?? "" }));
  return ok;
}

export async function handleInteraction(rawBody: string, enqueue: Enqueue) {
  const payload = JSON.parse(new URLSearchParams(rawBody).get("payload") ?? "{}");
  if (payload.type === "view_submission" && payload.view?.callback_id === SOCIAL_MODAL_CALLBACK_ID) {
    return handleSubmission(payload, enqueue);
  }
  if (payload.type === "block_actions") {
    const act = (payload.actions ?? []).find((a: { action_id?: string }) => a.action_id?.startsWith(SOCIAL_ACTION_PREFIX));
    if (!act) return ok;
    const action = act.action_id.slice(SOCIAL_ACTION_PREFIX.length);
    const post_id = Number(act.value);
    if (action === "edit") {
      const post = await (socialPostStore ??= new PostgresSocialPostStore(process.env.DATABASE_URL!)).get(post_id);
      if (post) await openModal(payload.trigger_id, modalView({ response_url: payload.response_url ?? "", post_id }, post));
      return ok;
    }
    await enqueue({ type: "social_post_action", post_id, action, user_id: payload.user?.id, response_url: payload.response_url ?? "" });
  }
  return ok;
}

async function handleSubmission(payload: any, enqueue: Enqueue) {
  const v = payload.view.state.values;
  const platform = v.platform?.platform?.selected_option?.value;
  const content = (v.content?.content?.value ?? "").trim();
  const media_url = (v.media_url?.media_url?.value ?? "").trim() || null;
  const seconds = v.scheduled_at?.scheduled_at?.selected_date_time;

  const errors: Record<string, string> = {};
  if (!content) errors.content = "Content is required.";
  if (platform === "instagram" && !media_url) errors.media_url = "Instagram posts require a media URL.";
  if (media_url && !/^https?:\/\//i.test(media_url)) errors.media_url = "Media URL must start with http:// or https://.";
  if (!seconds || seconds * 1000 <= Date.now()) errors.scheduled_at = "Scheduled time must be in the future.";
  if (Object.keys(errors).length) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_action: "errors", errors }),
    };
  }

  const meta = JSON.parse(payload.view.private_metadata || "{}");
  const fields = { platform, content, media_url, scheduled_at: new Date(seconds * 1000).toISOString() };
  await enqueue(meta.post_id
    ? { type: "social_post_edited", post_id: meta.post_id, ...fields, user_id: payload.user.id }
    : { type: "social_post_proposed", ...fields, proposer_id: payload.user.id, response_url: meta.response_url ?? "" });
  return ok;
}
