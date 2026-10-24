import type { Doc, Source } from "../plan.js";
import { NotConfigured, getJson } from "./http.js";

interface Message {
  text?: string;
  ts: string;
  user?: string;
  username?: string;
  permalink?: string;
  channel?: { id?: string; name?: string; is_private?: boolean; is_im?: boolean; is_mpim?: boolean };
}

async function slackApi<T>(method: string, token: string, params: Record<string, string>): Promise<T> {
  const body = await getJson<{ ok: boolean; error?: string } & T>(
    `https://slack.com/api/${method}?${new URLSearchParams(params)}`, { Authorization: `Bearer ${token}` });
  if (!body.ok) throw new Error(`Slack ${method}: ${body.error}`);
  return body;
}

const toDoc = (m: Message, url: string): Doc => ({
  source: "slack",
  url,
  title: `Slack message in #${m.channel?.name ?? "unknown"} by ${m.username ?? m.user ?? "unknown"}`,
  text: m.text ?? "",
});

const HISTORY_DAYS = 14;
const HISTORY_CHANNELS = 10;

// Public channels only. search.messages needs a user token (search:read) and searches as
// that user; without one, scan recent history of public channels the bot has joined.
export const slack: Source = async (plan) => {
  const userToken = process.env.SLACK_USER_TOKEN;
  if (userToken) {
    const r = await slackApi<{ messages: { matches: Message[] } }>("search.messages", userToken, { query: plan.query, count: "20" });
    const matches = r.messages.matches.filter((m) => m.channel && !m.channel.is_private && !m.channel.is_im
      && !m.channel.is_mpim && m.text !== plan.question);
    return { docs: matches.slice(0, 3).map((m) => toDoc(m, m.permalink ?? "")) };
  }
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) throw new NotConfigured("SLACK_BOT_TOKEN not set");
  const { channels } = await slackApi<{ channels: { id: string; name: string }[] }>("users.conversations", botToken,
    { types: "public_channel", exclude_archived: "true", limit: "200" });
  const oldest = String(Math.floor(Date.now() / 1000) - HISTORY_DAYS * 86_400);
  // ponytail: first HISTORY_CHANNELS channels only, keyword overlap scoring; a user token lifts both limits.
  const histories = await Promise.all(channels.slice(0, HISTORY_CHANNELS).map(async (channel) =>
    (await slackApi<{ messages: Message[] }>("conversations.history", botToken, { channel: channel.id, oldest, limit: "100" }))
      .messages.map((m) => ({ ...m, channel }))));
  const needed = Math.min(2, plan.terms.length);
  const hits = histories.flat()
    .filter((m) => m.text && m.text !== plan.question)
    .map((m) => ({ m, score: plan.terms.filter((t) => m.text!.toLowerCase().includes(t)).length }))
    .filter((h) => h.score >= needed)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const docs = await Promise.all(hits.map(async ({ m }) => toDoc(m,
    (await slackApi<{ permalink: string }>("chat.getPermalink", botToken, { channel: m.channel.id, message_ts: m.ts })).permalink)));
  return { docs, note: `search.messages off (SLACK_USER_TOKEN not set); scanned ${HISTORY_DAYS} days of joined public channels` };
};
