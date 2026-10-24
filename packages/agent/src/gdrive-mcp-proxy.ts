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
  // Serve /health first: 503 while google-docs-mcp starts, 200 once connected. The
  // agent checks it per message, so a slow or failed start degrades Drive, not the bot.
  let ready = false;
  let httpTransport: StreamableHTTPServerTransport | undefined;
  const httpServer = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/health") {
        res.writeHead(ready ? 200 : 503, { "Content-Type": "text/plain" });
        res.end(ready ? "ok" : "starting");
        return;
      }
      if (req.url === "/mcp" && httpTransport) {
        await httpTransport.handleRequest(req, res);
        return;
      }
      res.writeHead(req.url === "/mcp" ? 503 : 404);
      res.end();
    }
  );
  httpServer.listen(PORT, "127.0.0.1", () => {
    console.log(`[gdrive-proxy] HTTP listening on http://127.0.0.1:${PORT} (health 503 until ready)`);
  });

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

  httpTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(httpTransport);
  ready = true;
  console.log(`[gdrive-proxy] google-docs-mcp ready → http://127.0.0.1:${PORT}/mcp`);

  // If the stdio process dies, exit; docker-entrypoint.sh restarts the proxy.
  client.onclose = () => {
    console.error("[gdrive-proxy] google-docs-mcp process closed unexpectedly");
    process.exit(1);
  };
}

main().catch((err) => {
  console.error("[gdrive-proxy] Fatal:", err);
  process.exit(1);
});
