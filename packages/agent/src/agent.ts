import { query } from "@anthropic-ai/claude-agent-sdk";
import * as path from "path";
import { randomUUID } from "crypto";
import type { ImageContent } from "./slack.js";
import { providerEnv, resolveModel } from "./provider.js";

export async function runAgent(
  prompt: string,
  systemPrompt: string,
  model?: string,
  maxTokens?: number,
  images?: ImageContent[],
): Promise<string> {
  const maxRetries = parseInt(process.env.MAX_MCP_RETRIES ?? "2", 10);
  let lastError: Error | undefined;

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
      return await runAgentOnce(prompt, systemPrompt, model, maxTokens, images);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (!isTransientError(lastError)) throw lastError;
    }
  }

  throw lastError ?? new Error("runAgent: no attempts made");
}

function isTransientError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("socket") ||
    msg.includes("network") ||
    msg.includes("overloaded") ||
    msg.includes("rate_limit") ||
    msg.includes("server_error")
  );
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

async function runAgentOnce(
  prompt: string,
  systemPrompt: string,
  model?: string,
  maxTokens?: number,
  images?: ImageContent[],
): Promise<string> {
  const urlFetcherPath = path.resolve(
    __dirname,
    "../../mcp-url-fetcher/dist/index.js"
  );

  // The gdrive MCP proxy is started at container boot (docker-entrypoint.sh).
  // It spawns google-docs-mcp once, waits for auth, then exposes an HTTP server.
  // Connecting via URL is instant — no per-query cold-start or handshake timeout.
  const gdriveProxyUrl = process.env.GDRIVE_MCP_PROXY_URL;

  console.log("[agent] MCP servers:", JSON.stringify({
    gdrive: !!gdriveProxyUrl,
    github: !!process.env.GITHUB_TOKEN,
    urlFetcher: true,
    images: images?.length ?? 0,
  }));

  const sdkPrompt = images?.length
    ? buildImagePrompt(prompt, images)
    : prompt;

  let result = "";

  for await (const message of query({
    prompt: sdkPrompt,
    options: {
      model: resolveModel(model),
      systemPrompt,
      env: { ...process.env, ...providerEnv() },
      allowedTools: [
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
        // GitHub — write
        "mcp__github__create_issue",
        "mcp__github__add_issue_comment",
        "mcp__github__create_pull_request_review",
      ],
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      mcpServers: {
        ...(gdriveProxyUrl ? {
          gdrive: {
            type: "http" as const,
            url: gdriveProxyUrl,
          },
        } : {}),
        github: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: {
            GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN!,
          },
        },
        urlFetcher: {
          command: "node",
          args: [urlFetcherPath],
          env: {
            DATABASE_URL: process.env.DATABASE_URL!,
            URL_POLL_INTERVAL_S: process.env.URL_POLL_INTERVAL_S ?? "60",
          },
        },
      },
    },
  })) {
    if ("result" in message) {
      result = message.result;
    }
  }

  return result || "I was unable to generate a response.";
}
