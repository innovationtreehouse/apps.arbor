/**
 * Google Drive MCP HTTP Proxy
 *
 * Runs at container startup. Spawns google-docs-mcp via stdio (which does a
 * ~5s auth+init once), then exposes an MCP Streamable-HTTP server on
 * localhost:8123. The agent connects via { type: 'http', url: '...' }
 * and gets sub-millisecond connection time for every subsequent query.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "crypto";

const PORT = parseInt(process.env.GDRIVE_MCP_PORT ?? "8123", 10);
const SERVICE_ACCOUNT_PATH = process.env.SERVICE_ACCOUNT_PATH;
const GOOGLE_IMPERSONATE_USER = process.env.GOOGLE_IMPERSONATE_USER;
// Use the installed binary. Slow startup (~5s) is acceptable because the proxy
// runs once at container boot and stays up for the container's lifetime.
const MCP_SCRIPT =
  "/usr/local/lib/node_modules/@a-bonus/google-docs-mcp/dist/index.js";

if (!SERVICE_ACCOUNT_PATH) {
  console.error("[gdrive-proxy] SERVICE_ACCOUNT_PATH not set — exiting");
  process.exit(1);
}

async function main() {
  console.log("[gdrive-proxy] Spawning google-docs-mcp (auth may take ~5s)...");

  const client = new Client(
    { name: "gdrive-proxy", version: "1.0.0" },
    { capabilities: {} }
  );

  const clientTransport = new StdioClientTransport({
    command: "node",
    args: [MCP_SCRIPT],
    // Only the auth vars; the transport adds PATH, HOME and the other safe defaults.
    // The child never sees DATABASE_URL, tokens or API keys.
    env: {
      SERVICE_ACCOUNT_PATH: SERVICE_ACCOUNT_PATH!,
      ...(GOOGLE_IMPERSONATE_USER ? { GOOGLE_IMPERSONATE_USER } : {}),
      ...(process.env.NODE_ENV ? { NODE_ENV: process.env.NODE_ENV } : {}),
    },
    stderr: "inherit",
  });

  await client.connect(clientTransport);
  console.log("[gdrive-proxy] google-docs-mcp ready.");

  // --- HTTP MCP server (Streamable HTTP transport) ---

  const server = new Server(
    { name: "gdrive-proxy", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async (req) => {
    return client.listTools(req.params);
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return client.callTool(req.params);
  });

  const httpTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  await server.connect(httpTransport);

  const httpServer = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }
      if (req.url === "/mcp") {
        await httpTransport.handleRequest(req, res);
        return;
      }
      res.writeHead(404);
      res.end();
    }
  );

  httpServer.listen(PORT, "127.0.0.1", () => {
    console.log(`[gdrive-proxy] HTTP MCP ready → http://127.0.0.1:${PORT}/mcp`);
  });

  // If the stdio process dies, crash the proxy so the container restarts.
  client.onclose = () => {
    console.error("[gdrive-proxy] google-docs-mcp process closed unexpectedly");
    process.exit(1);
  };
}

main().catch((err) => {
  console.error("[gdrive-proxy] Fatal:", err);
  process.exit(1);
});
