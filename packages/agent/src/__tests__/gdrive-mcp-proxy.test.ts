import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server as HttpServer } from "http";
import type { AddressInfo } from "net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mcpHandler } from "../gdrive-mcp-proxy.js";

let http: HttpServer | undefined;
afterEach(() => http?.close());

describe("gdrive proxy mcpHandler", () => {
  it("serves several clients one after another (a stateful transport rejected the second initialize)", async () => {
    const upstream = {
      listTools: vi.fn().mockResolvedValue({ tools: [{ name: "readDocument", inputSchema: { type: "object" } }] }),
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "doc body" }] }),
    };
    http = createServer(mcpHandler(upstream as never));
    await new Promise<void>((resolve) => http!.listen(0, "127.0.0.1", resolve));
    const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);

    for (const n of [1, 2, 3]) {
      const client = new Client({ name: `c${n}`, version: "1" });
      await client.connect(new StreamableHTTPClientTransport(url));
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["readDocument"]);
      expect(await client.callTool({ name: "readDocument", arguments: { documentId: "d" } }))
        .toMatchObject({ content: [{ type: "text", text: "doc body" }] });
      await client.close();
    }
    expect(upstream.callTool).toHaveBeenCalledTimes(3);
  });
});
