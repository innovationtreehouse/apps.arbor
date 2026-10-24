import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { PostgresUrlStore } from "@arbor/db";
import { UrlConfig } from "./config.js";

export { UrlConfig };

const MAX_CONTENT_CHARS = 20_000;
const AGENT_NAME = process.env.AGENT_NAME ?? "Squirrel";

export function listToolsHandler() {
  return {
    tools: [
      {
        name: "url_list",
        description:
          `List all URLs that ${AGENT_NAME} is configured to fetch. ` +
          "Use this to discover what web sources are available before fetching.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "url_fetch",
        description:
          "Fetch the text content of a URL from the approved allowlist. " +
          "Any URL that starts with a prefix shown in url_list (entries ending with *) is permitted.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The URL to fetch (must match an allowlist entry or its wildcard prefix)",
            },
          },
          required: ["url"],
        },
      },
    ],
  };
}

// Hostname check only (no DNS): a public name that resolves to a private address still passes.
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h === "localhost" || /\.(localhost|local|internal)$/.test(h)) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return /^(127|10|0|192\.168|169\.254|172\.(1[6-9]|2\d|3[01]))\./.test(h);
  // IPv6 loopback/unspecified, fc00::/7 unique-local, fe80::/10 link-local, IPv4-mapped.
  return h.includes(":") && (h === "::1" || h === "::" || /^(f[cd]|fe[89ab])[0-9a-f]*:/.test(h) || h.startsWith("::ffff:"));
}

async function fetchPublic(url: string, signal?: AbortSignal): Promise<Response> {
  if (isPrivateHost(new URL(url).hostname)) throw new Error(`refusing private or local host: ${url}`);
  const timeout = AbortSignal.timeout(15_000);
  return fetch(url, {
    headers: { "User-Agent": "Squirrel-Bot/1.0" },
    redirect: "manual",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
}

const isRedirect = (res: Response) => res.status >= 300 && res.status < 400;

// Allowlisted, public-host fetch that follows one redirect only to another allowlisted URL.
// Throws on refusal; the caller checks response.ok. Also used by the agent's research step.
export async function fetchAllowed(config: UrlConfig, url: string, signal?: AbortSignal): Promise<Response> {
  if (!config.isAllowed(url)) throw new Error(`URL not on allowlist: ${url}`);
  const response = await fetchPublic(url, signal);
  if (!isRedirect(response)) return response;
  const location = response.headers.get("location");
  const next = location ? new URL(location, url).href : "(no Location header)";
  if (!config.isAllowed(next)) throw new Error(`Redirect from ${url} to ${next} is not on the allowlist`);
  const final = await fetchPublic(next, signal);
  if (isRedirect(final)) throw new Error(`Too many redirects for ${url}`);
  return final;
}

const ok = (text: string) => ({ content: [{ type: "text", text }] });
const err = (text: string) => ({ isError: true, content: [{ type: "text", text }] });

export async function callToolHandler(
  config: UrlConfig,
  name: string,
  args: unknown
) {
  if (name === "url_list") {
    const entries = config.getAll();
    if (entries.length === 0) return ok("No URLs are currently configured.");
    const lines = entries.map((e) => `- ${e.url}\n  ${e.description}`);
    return ok("Configured URLs:\n" + lines.join("\n"));
  }

  if (name === "url_fetch") {
    const url = (args as Record<string, unknown>)?.url;
    if (typeof url !== "string" || !url) return err("Missing required parameter: url");
    if (!config.isAllowed(url)) {
      return err(`URL not on allowlist: ${url}\nUse url_list to see available URLs.`);
    }

    try {
      const response = await fetchAllowed(config, url);
      if (!response.ok) return err(`HTTP ${response.status} ${response.statusText} for ${url}`);

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text") && !contentType.includes("json")) {
        return err(`Unsupported content type: ${contentType}. Only text and JSON are supported.`);
      }

      let text = await response.text();
      if (text.length > MAX_CONTENT_CHARS) {
        text =
          text.slice(0, MAX_CONTENT_CHARS) +
          `\n\n[Content truncated at ${MAX_CONTENT_CHARS} characters]`;
      }

      const description = config.getDescription(url);
      return ok(`Source: ${url}${description ? ` (${description})` : ""}\n\n${text}`);
    } catch (e: unknown) {
      return err(`Fetch error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return err(`Unknown tool: ${name}`);
}

/* v8 ignore start */
async function main() {
  const store = new PostgresUrlStore(process.env.DATABASE_URL!);
  const config = new UrlConfig(store);
  await config.load();
  config.startPolling();

  const server = new Server(
    { name: "arbor-url-fetcher", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, listToolsHandler);
  server.setRequestHandler(CallToolRequestSchema, (req) =>
    callToolHandler(config, req.params.name, req.params.arguments)
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[url-fetcher] MCP server running on stdio");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[url-fetcher] Fatal error:", err);
    process.exit(1);
  });
}
/* v8 ignore stop */
