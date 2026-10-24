import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { PostgresConfigStore, PostgresAuditStore, PostgresUrlStore } from "@arbor/db";
import type { ConfigStore } from "@arbor/db";
import { createAuditLogger } from "@arbor/logger";
import { fetchChannelHistory, fetchThreadHistory, fetchSlackImages, postMessage, postEphemeral } from "./slack.js";
import type { SlackFile } from "./slack.js";
import { runAgent } from "./agent.js";
import { buildPrompt, buildSystemPrompt, NO_REPLY_SENTINEL } from "./prompt.js";
import { BatchBuffer, type BatchEvent } from "./batch-buffer.js";
import { processAdminCommand } from "./admin.js";
import { providerEnv } from "./provider.js";

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
const auditLogger = createAuditLogger(auditStore);
const IDLE_TIMEOUT_MS =
  parseInt(process.env.IDLE_TIMEOUT ?? "15", 10) * 60 * 1000;
const SQS_WAIT_SECONDS = 20;

// Number of channel messages to include as compacted context in thread replies
const THREAD_CHANNEL_CONTEXT = 4;

// A failed config read falls back to defaults so the user still gets a reply.
async function resolveConfig(store: ConfigStore, channel: string) {
  const keys = ["model", `token_limit:${channel}`, "token_limit:default", "prompt:system", "prompt:user"];
  const results = await Promise.allSettled(keys.map((key) => store.get(key)));
  const failed = results.flatMap((r, i) => (r.status === "rejected" ? [`${keys[i]}: ${r.reason}`] : []));
  if (failed.length > 0) console.error(`[agent] config read failed, using defaults: ${failed.join("; ")}`);
  const [model, channelLimit, defaultLimit, systemOverride, userTemplate] =
    results.map((r) => (r.status === "fulfilled" ? r.value : undefined));
  const limit = parseInt(channelLimit ?? defaultLimit ?? "", 10);
  return {
    model,
    maxTokens: limit > 0 ? limit : undefined,
    systemOverride: systemOverride || undefined,
    userTemplate: userTemplate || undefined,
  };
}

export async function processEvent(event: SlackEvent): Promise<void> {
  // Only show the ephemeral "Searching…" when we know we'll always reply.
  // For discretion-mode events, skip it — the bot may decide not to reply
  // and a dangling "Searching…" with no follow-up is confusing.
  if (!event.requires_discretion) {
    await postEphemeral(event.channel, event.user, "_Searching…_");
  }

  const { model, maxTokens, systemOverride, userTemplate } = await resolveConfig(configStore, event.channel);

  // Fetch conversation history based on context type:
  // - thread: full thread + up to THREAD_CHANNEL_CONTEXT recent channel messages
  // - IM or channel (top-level): full conversation/channel history
  const history = await fetchThreadHistory(event.channel, event.thread_ts);
  const channelContext = event.is_thread
    ? await fetchChannelHistory(event.channel, THREAD_CHANNEL_CONTEXT).catch(() => [])
    : [];

  const prompt = buildPrompt(history, event.text, userTemplate, channelContext);
  const systemPrompt = buildSystemPrompt(
    systemOverride,
    userTemplate,
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
  providerEnv(); // throws if OPENROUTER_API_KEY is missing
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
      if (parsed.type === "admin_command") {
        await processAdminCommand(parsed, { urlStore, configStore, auditStore });
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
