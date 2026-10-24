import { WebClient } from "@slack/web-api";
import type { SlackMessage } from "./prompt.js";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const client = new WebClient(SLACK_BOT_TOKEN);

// Slack rejects messages over 4000 chars; replies are cut to this length.
export const SLACK_MAX_CHARS = 3900;

const THREAD_HISTORY_LIMIT = parseInt(
  process.env.THREAD_HISTORY_LIMIT ?? "50",
  10
);

const CHANNEL_HISTORY_LIMIT = parseInt(
  process.env.CHANNEL_HISTORY_LIMIT ?? "20",
  10
);

export async function fetchThreadHistory(
  channel: string,
  threadTs: string
): Promise<SlackMessage[]> {
  const result = await client.conversations.replies({
    channel,
    ts: threadTs,
    limit: THREAD_HISTORY_LIMIT,
  });

  return (result.messages ?? []) as SlackMessage[];
}

// Fetches recent top-level messages from a channel or IM.
// Excludes thread replies (replies live under their parent, not in history).
export async function fetchChannelHistory(
  channel: string,
  limit = CHANNEL_HISTORY_LIMIT
): Promise<SlackMessage[]> {
  const result = await client.conversations.history({
    channel,
    limit,
  });

  // conversations.history returns messages newest-first; reverse to chronological
  return ((result.messages ?? []) as SlackMessage[]).reverse();
}

export async function postMessage(
  channel: string,
  threadTs: string,
  text: string
): Promise<void> {
  const truncated =
    text.length > SLACK_MAX_CHARS ? text.slice(0, SLACK_MAX_CHARS - 3) + "…" : text;

  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: truncated,
  });
}

export async function postEphemeral(
  channel: string,
  userId: string,
  text: string
): Promise<void> {
  await client.chat.postEphemeral({
    channel,
    user: userId,
    text,
  });
}

// ---------------------------------------------------------------------------
// Image fetching
// ---------------------------------------------------------------------------

export interface SlackFile {
  url_private: string;
  mimetype: string;
  name?: string;
}

export interface ImageContent {
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string; // base64
}

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

// 4MB limit — well under Claude's 5MB per image cap
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export async function fetchSlackImages(
  files: SlackFile[]
): Promise<ImageContent[]> {
  if (!SLACK_BOT_TOKEN) return [];

  const results: ImageContent[] = [];
  for (const file of files) {
    if (!SUPPORTED_IMAGE_TYPES.has(file.mimetype)) continue;
    try {
      const res = await fetch(file.url_private, {
        headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        console.warn(`[images] Failed to fetch ${file.name ?? file.url_private}: HTTP ${res.status}`);
        continue;
      }
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength > MAX_IMAGE_BYTES) {
        console.warn(`[images] Skipping ${file.name ?? file.url_private}: ${buffer.byteLength} bytes exceeds ${MAX_IMAGE_BYTES} limit`);
        continue;
      }
      results.push({
        mediaType: file.mimetype as ImageContent["mediaType"],
        data: Buffer.from(buffer).toString("base64"),
      });
    } catch (err) {
      console.warn(`[images] Error fetching ${file.name ?? file.url_private}:`, err);
    }
  }
  return results;
}
