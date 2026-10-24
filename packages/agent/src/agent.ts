import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import * as path from "path";
import { randomUUID } from "crypto";
import type { ImageContent } from "./slack.js";
import { providerEnv, resolveModel } from "./provider.js";
import { driveStatus, type DriveStatus } from "./retrieval/sources/drive.js";

// Unset, non-numeric or non-positive values fall back to the default.
function positiveIntEnv(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? "", 10);
  return n > 0 ? n : fallback;
}

export async function runAgent(
  prompt: string,
  systemPrompt: string,
  model?: string,
  maxTokens?: number,
  images?: ImageContent[],
): Promise<string> {
  const maxRetries = parseInt(process.env.MAX_MCP_RETRIES ?? "2", 10);
  // Under the 300 s SQS visibility timeout, leaving room for the pre-agent Slack/DB steps.
  const timeoutS = positiveIntEnv("AGENT_TIMEOUT_S", 240);
  // One deadline across all attempts, so a hung MCP server cannot stall the SQS loop.
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutS * 1000);
  const drive = await driveStatus();
  const options = buildQueryOptions(systemPrompt + DRIVE_NOTE[drive], model, maxTokens, abortController, drive);
  let lastError: Error | undefined;

  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const base = Math.min(1000 * 2 ** (attempt - 1), 10_000);
        const delayMs = base * (1 + Math.random() * 0.1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        console.warn(
          `[agent] attempt ${attempt}/${maxRetries + 1} failed (${lastError?.message}), retried after ${Math.round(delayMs)}ms`
        );
      }

      try {
        const result = await runAgentOnce(prompt, options, images);
        if (!abortController.signal.aborted) return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (!abortController.signal.aborted && !isTransientError(lastError)) throw lastError;
      }
      if (abortController.signal.aborted) throw new Error(`Agent timed out after ${timeoutS}s`);
    }
  } finally {
    clearTimeout(timer);
  }

  throw lastError ?? new Error("runAgent: no attempts made");
}

// Network blips, provider overload/rate limits and timeouts; anything else is a real failure.
const TRANSIENT_ERROR = /econnreset|econnrefused|etimedout|eai_again|socket hang up|timed out|timeout|overloaded|rate_limit|server_error/;

function isTransientError(err: Error): boolean {
  return TRANSIENT_ERROR.test(err.message.toLowerCase());
}

// Build a multi-modal prompt as an AsyncIterable<SDKUserMessage> when images
// are present. The SDK accepts this form for rich message content.
async function* buildImagePrompt(
  text: string,
  images: ImageContent[]
) {
  yield {
    type: "user" as const,
    message: {
      role: "user" as const,
      content: [
        ...images.map((img) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: img.mediaType,
            data: img.data,
          },
        })),
        { type: "text" as const, text },
      ],
    },
    parent_tool_use_id: null,
    session_id: randomUUID(),
  };
}

// Plain data so new MCP servers and tools can be added without touching the query loop.
export const ALLOWED_TOOLS = [
  // URL fetcher — read allowed URLs
  "mcp__urlFetcher__url_fetch",
  "mcp__urlFetcher__url_list",
  // Google Drive — read
  "mcp__gdrive__listDocuments",
  "mcp__gdrive__searchDocuments",
  "mcp__gdrive__listDriveFiles",
  "mcp__gdrive__searchDriveFiles",
  "mcp__gdrive__getDocumentInfo",
  "mcp__gdrive__listFolderContents",
  "mcp__gdrive__getFolderInfo",
  "mcp__gdrive__readDocument",
  "mcp__gdrive__downloadFile",
  // Google Drive — write
  "mcp__gdrive__createDocument",
  "mcp__gdrive__appendText",
  "mcp__gdrive__insertText",
  // GitHub — read
  "mcp__github__search_repositories",
  "mcp__github__search_code",
  "mcp__github__search_issues",
  "mcp__github__get_file_contents",
  "mcp__github__list_commits",
  "mcp__github__get_commit",
  "mcp__github__get_issue",
  "mcp__github__list_issues",
  "mcp__github__get_pull_request",
  "mcp__github__list_pull_requests",
  "mcp__github__get_pull_request_files",
  // GitHub is read-only: no create_issue / add_issue_comment / create_pull_request_review.
];

// Tell the model why Drive tools are missing instead of letting it guess.
const DRIVE_NOTE: Record<DriveStatus, string> = {
  ready: "",
  unavailable: "\n\nGoogle Drive is temporarily unavailable (its connector is not healthy), so Drive tools are " +
    "not offered for this message. If the user needs Drive content, say Drive is temporarily unreachable; do not " +
    "say you lack Drive access.",
  "not configured": "\n\nGoogle Drive is not configured in this deployment; Drive tools are not available.",
};

function mcpServers(drive: DriveStatus): Options["mcpServers"] {
  // The gdrive MCP proxy is started at container boot (docker-entrypoint.sh) and
  // exposes HTTP; it is offered only while its /health says it is connected.
  const gdriveProxyUrl = process.env.GDRIVE_MCP_PROXY_URL;
  return {
    ...(gdriveProxyUrl && drive === "ready" ? { gdrive: { type: "http" as const, url: gdriveProxyUrl } } : {}),
    github: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN! },
    },
    urlFetcher: {
      command: "node",
      args: [path.resolve(__dirname, "../../mcp-url-fetcher/dist/index.js")],
      env: {
        DATABASE_URL: process.env.DATABASE_URL!,
        URL_POLL_INTERVAL_S: process.env.URL_POLL_INTERVAL_S ?? "60",
      },
    },
  };
}

// The SDK has no maxTokens option; the CLI caps each response via CLAUDE_CODE_MAX_OUTPUT_TOKENS.
function buildQueryOptions(
  systemPrompt: string,
  model: string | undefined,
  maxTokens: number | undefined,
  abortController: AbortController,
  drive: DriveStatus,
): Options {
  return {
    model: resolveModel(model),
    systemPrompt,
    env: {
      ...process.env,
      ...providerEnv(),
      ...(maxTokens !== undefined ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens) } : {}),
    },
    allowedTools: ALLOWED_TOOLS,
    mcpServers: mcpServers(drive),
    maxTurns: positiveIntEnv("AGENT_MAX_TURNS", 30),
    abortController,
  };
}

async function runAgentOnce(
  prompt: string,
  options: Options,
  images?: ImageContent[],
): Promise<string> {
  console.log("[agent] MCP servers:", JSON.stringify({
    gdrive: Object.keys(options.mcpServers ?? {}).includes("gdrive"),
    github: !!process.env.GITHUB_TOKEN,
    urlFetcher: true,
    images: images?.length ?? 0,
  }));

  const sdkPrompt = images?.length ? buildImagePrompt(prompt, images) : prompt;
  let result = "";
  for await (const message of query({ prompt: sdkPrompt, options })) {
    if ("result" in message) {
      result = message.result;
    }
    if (message.type === "result") {
      console.log(`[usage] ${JSON.stringify({ stage: "answer", cost: message.total_cost_usd, usage: message.usage })}`);
    }
  }

  return result || "I was unable to generate a response.";
}
