import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { PostgresConfigStore, PostgresAuditStore, PostgresUrlStore, PostgresSocialPostStore } from "@arbor/db";
import { createAuditLogger } from "@arbor/logger";
import { fetchChannelHistory, fetchThreadHistory, fetchSlackImages, postMessage, postEphemeral } from "./slack.js";
import type { SlackFile } from "./slack.js";
import { runAgent } from "./agent.js";
import { buildPrompt, buildSystemPrompt } from "./prompt.js";
import { BatchBuffer, type BatchEvent } from "./batch-buffer.js";
import { processAdminCommand } from "./admin.js";
import { processSocialPostMessage } from "./social-posts.js";

export const NO_REPLY_SENTINEL = "__NO_REPLY__";

export type SlackEvent = BatchEvent & {
  holdoff?: boolean;
  channel_type?: "channel" | "im";
  is_mention?: boolean;
  is_thread?: boolean;
  requires_discretion?: boolean;
  files?: SlackFile[];
};

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

const sqsClient = new SQSClient({ region: process.env.AWS_REGION });
const configStore = new PostgresConfigStore(DATABASE_URL);
const urlStore = new PostgresUrlStore(DATABASE_URL);
const auditStore = new PostgresAuditStore(DATABASE_URL);
const socialPostStore = new PostgresSocialPostStore(DATABASE_URL);
const auditLogger = createAuditLogger(auditStore);
const IDLE_TIMEOUT_MS =
  parseInt(process.env.IDLE_TIMEOUT ?? "15", 10) * 60 * 1000;
const SQS_WAIT_SECONDS = 20;

// Number of channel messages to include as compacted context in thread replies
const THREAD_CHANNEL_CONTEXT = 4;

export async function processEvent(event: SlackEvent): Promise<void> {
  // Only show the ephemeral "Searching…" when we know we'll always reply.
  // For discretion-mode events, skip it — the bot may decide not to reply
  // and a dangling "Searching…" with no follow-up is confusing.
  if (!event.requires_discretion) {
    await postEphemeral(event.channel, event.user, "_Searching…_");
  }

  const [model, channelLimit, defaultLimit, systemOverride, userTemplate] = await Promise.all([
    configStore.get("model").catch(() => undefined),
    configStore.get(`token_limit:${event.channel}`).catch(() => undefined),
    configStore.get("token_limit:default").catch(() => undefined),
    configStore.get("prompt:system").catch(() => undefined),
    configStore.get("prompt:user").catch(() => undefined),
  ]);
  const rawLimit = channelLimit ?? defaultLimit;
  const maxTokens = rawLimit !== undefined && parseInt(rawLimit, 10) > 0 ? parseInt(rawLimit, 10) : undefined;

  // Fetch conversation history based on context type:
  // - thread: full thread + up to THREAD_CHANNEL_CONTEXT recent channel messages
  // - IM or channel (top-level): full conversation/channel history
  const history = await fetchThreadHistory(event.channel, event.thread_ts);
  const channelContext = event.is_thread
    ? await fetchChannelHistory(event.channel, THREAD_CHANNEL_CONTEXT).catch(() => [])
    : [];

  const prompt = buildPrompt(history, event.text, userTemplate || undefined, channelContext);
  const systemPrompt = buildSystemPrompt(
    systemOverride || undefined,
    userTemplate || undefined,
    { requiresDiscretion: event.requires_discretion ?? false }
  );

  const images = event.files?.length
    ? await fetchSlackImages(event.files).catch(() => [])
    : [];

  const start = Date.now();
  const response = await runAgent(prompt, systemPrompt, model, maxTokens, images);
  const duration_ms = Date.now() - start;

  if (response.trim() === NO_REPLY_SENTINEL) {
    console.log(`[discretion] agent elected not to reply in channel ${event.channel}`);
    return;
  }

  await postMessage(event.channel, event.thread_ts, response);
  await auditLogger.log({
    channel: event.channel,
    thread_ts: event.thread_ts,
    user_id: event.user,
    prompt,
    response,
    model: model ?? null,
    duration_ms,
  });
}

/* v8 ignore start */
async function main(): Promise<void> {
  console.log("Arbor agent started, polling SQS...");
  let idleMs = 0;

  const batchBuffer = new BatchBuffer(60_000, async (events) => {
    for (const event of events) {
      await processEvent(event).catch((err) =>
        console.error("Batch event failed:", err)
      );
    }
  });

  while (true) {
    const result = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: process.env.SQS_QUEUE_URL!,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: SQS_WAIT_SECONDS,
      })
    );

    if (!result.Messages || result.Messages.length === 0) {
      idleMs += SQS_WAIT_SECONDS * 1000;
      if (idleMs >= IDLE_TIMEOUT_MS) {
        console.log(
          `Idle for ${IDLE_TIMEOUT_MS / 60_000}m with no messages — shutting down.`
        );
        await batchBuffer.flushAll();
        process.exit(0);
      }
      continue;
    }

    idleMs = 0;
    const sqsMessage = result.Messages[0];

    try {
      const parsed = JSON.parse(sqsMessage.Body!);
      if (typeof parsed.type === "string" && parsed.type.startsWith("social_post")) {
        await processSocialPostMessage(parsed, { socialPostStore, configStore, auditStore });
      } else if (parsed.type === "admin_command") {
        await processAdminCommand(parsed, { urlStore, configStore, auditStore, socialPostStore });
      } else {
        const event: SlackEvent = parsed;
        if (event.holdoff) {
          batchBuffer.add(event);
        } else {
          await processEvent(event);
        }
      }
    } catch (err) {
      console.error("Failed to process event:", err);
    }

    await sqsClient.send(
      new DeleteMessageCommand({
        QueueUrl: process.env.SQS_QUEUE_URL!,
        ReceiptHandle: sqsMessage.ReceiptHandle!,
      })
    );
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
/* v8 ignore stop */
