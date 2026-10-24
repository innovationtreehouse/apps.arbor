import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Source } from "../plan.js";
import { NotConfigured } from "./http.js";

export type DriveStatus = "ready" | "unavailable" | "not configured";
let cached: { at: number; status: DriveStatus } | undefined;

// The proxy's /health is 200 only once google-docs-mcp is connected. Cached for 30 s
// because both the research step and runAgent ask on every message.
export async function driveStatus(): Promise<DriveStatus> {
  const url = process.env.GDRIVE_MCP_PROXY_URL;
  if (!url) return "not configured";
  if (cached && Date.now() - cached.at < 30_000) return cached.status;
  const ok = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(2_000) }).then((r) => r.ok, () => false);
  cached = { at: Date.now(), status: ok ? "ready" : "unavailable" };
  return cached.status;
}

export function resetDriveStatus(): void {
  cached = undefined;
}

const GOOGLE_DOC = "application/vnd.google-apps.document";
type ToolResult = { content?: { type: string; text?: string }[] };
const resultText = (r: unknown) => ((r as ToolResult).content ?? []).map((c) => c.text ?? "").join("\n");

// Search Drive through the proxy, then read the top Google Docs; other files become link cards.
export const drive: Source = async (plan) => {
  const status = await driveStatus();
  if (status === "not configured") throw new NotConfigured("GDRIVE_MCP_PROXY_URL not set (no GOOGLE_CREDENTIALS)");
  if (status === "unavailable") throw new Error("Drive unavailable: the gdrive proxy is not healthy");
  const client = new Client({ name: "arbor-research", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(process.env.GDRIVE_MCP_PROXY_URL!)));
  try {
    const search = await client.callTool({
      name: "searchDriveFiles",
      arguments: { query: plan.terms.slice(0, 3).join(" "), maxResults: 5 },
    });
    const { files = [] } = JSON.parse(resultText(search)) as {
      files?: { id: string; name: string; mimeType: string; url: string; modifiedTime?: string }[];
    };
    const docs = await Promise.all(files.slice(0, 3).map(async (f) => f.mimeType === GOOGLE_DOC
      ? { source: "drive", url: f.url, title: f.name,
          text: resultText(await client.callTool({ name: "readDocument", arguments: { documentId: f.id, maxLength: 12_000 } })) }
      : { source: "drive", url: f.url, title: f.name, text: `Drive file (${f.mimeType}), modified ${f.modifiedTime ?? "unknown"}.`, link: true }));
    return { docs };
  } finally {
    await client.close();
  }
};
