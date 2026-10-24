import { beforeEach, describe, expect, it, vi } from "vitest";
import { callToolHandler, fetchAllowed, isPrivateHost, listToolsHandler } from "../index.js";
import { UrlConfig } from "../config.js";

// Mock UrlConfig so we control allowlist contents without DynamoDB
vi.mock("../config.js", () => {
  const allowed = new Map<string, { url: string; description: string; enabled: boolean; added_by: string; added_at: string }>([
    ["https://docs.example.com", { url: "https://docs.example.com", description: "API Docs", enabled: true, added_by: "U1", added_at: "" }],
  ]);

  const MockUrlConfig = vi.fn().mockImplementation(function () {
    return {
      load: vi.fn().mockResolvedValue(undefined),
      startPolling: vi.fn(),
      isAllowed: vi.fn((url: string) => allowed.has(url)),
      getAll: vi.fn(() => Array.from(allowed.values())),
      getDescription: vi.fn((url: string) => allowed.get(url)?.description ?? ""),
    };
  });

  return { UrlConfig: MockUrlConfig };
});

let config: InstanceType<typeof UrlConfig>;

beforeEach(() => {
  config = new UrlConfig({} as any);
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// listToolsHandler
// ---------------------------------------------------------------------------

describe("listToolsHandler", () => {
  it("returns exactly two tools: url_list and url_fetch", () => {
    const result = listToolsHandler();
    expect(result.tools).toHaveLength(2);
    expect(result.tools.map((t) => t.name)).toEqual(["url_list", "url_fetch"]);
  });

  it("url_fetch tool has 'url' as a required parameter", () => {
    const fetchTool = listToolsHandler().tools.find((t) => t.name === "url_fetch")!;
    expect(fetchTool.inputSchema.required).toContain("url");
  });
});

// ---------------------------------------------------------------------------
// callToolHandler — url_list
// ---------------------------------------------------------------------------

describe("callToolHandler: url_list", () => {
  it("returns a formatted list of configured URLs", async () => {
    const result = await callToolHandler(config, "url_list", {});
    expect(result.content[0].text).toContain("https://docs.example.com");
    expect(result.content[0].text).toContain("API Docs");
  });

  it("returns 'no URLs' message when allowlist is empty", async () => {
    vi.mocked(config.getAll).mockReturnValueOnce([]);
    const result = await callToolHandler(config, "url_list", {});
    expect(result.content[0].text).toContain("No URLs are currently configured");
  });
});

// ---------------------------------------------------------------------------
// callToolHandler — url_fetch
// ---------------------------------------------------------------------------

describe("callToolHandler: url_fetch", () => {
  it("returns error when url parameter is missing", async () => {
    const result = await callToolHandler(config, "url_fetch", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Missing required parameter");
  });

  it("returns error when URL is not on allowlist", async () => {
    const result = await callToolHandler(config, "url_fetch", { url: "https://evil.com" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not on allowlist");
  });

  it("returns fetched content for an allowed URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => "text/html; charset=utf-8" },
        text: async () => "<html>Hello docs</html>",
      })
    );

    const result = await callToolHandler(config, "url_fetch", {
      url: "https://docs.example.com",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("https://docs.example.com");
    expect(result.content[0].text).toContain("API Docs");
    expect(result.content[0].text).toContain("Hello docs");
  });

  it("includes description in output when available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => "text/plain" },
        text: async () => "content",
      })
    );

    const result = await callToolHandler(config, "url_fetch", {
      url: "https://docs.example.com",
    });

    expect(result.content[0].text).toContain("(API Docs)");
  });

  it("returns error on non-ok HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: "Service Unavailable" })
    );

    const result = await callToolHandler(config, "url_fetch", {
      url: "https://docs.example.com",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("503");
  });

  it("returns error for non-text content type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => "application/octet-stream" },
      })
    );

    const result = await callToolHandler(config, "url_fetch", {
      url: "https://docs.example.com",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unsupported content type");
  });

  it("accepts application/json content type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        text: async () => '{"key":"value"}',
      })
    );

    const result = await callToolHandler(config, "url_fetch", {
      url: "https://docs.example.com",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("key");
  });

  it("truncates content exceeding MAX_CONTENT_CHARS", async () => {
    const hugeContent = "a".repeat(25_000);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => "text/plain" },
        text: async () => hugeContent,
      })
    );

    const result = await callToolHandler(config, "url_fetch", {
      url: "https://docs.example.com",
    });

    expect(result.content[0].text).toContain("truncated");
  });

  it("returns error on fetch exception", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const result = await callToolHandler(config, "url_fetch", {
      url: "https://docs.example.com",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ECONNREFUSED");
  });
});

// ---------------------------------------------------------------------------
// callToolHandler — unknown tool
// ---------------------------------------------------------------------------

describe("callToolHandler: unknown tool", () => {
  it("returns error for an unrecognised tool name", async () => {
    const result = await callToolHandler(config, "nonexistent_tool", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown tool");
  });
});

// ---------------------------------------------------------------------------
// private / local hosts
// ---------------------------------------------------------------------------

describe("isPrivateHost", () => {
  it.each([
    "localhost", "LOCALHOST", "foo.localhost", "127.0.0.1", "10.1.2.3", "192.168.0.1",
    "172.16.0.1", "172.31.255.255", "169.254.169.254", "0.0.0.0", "[::1]", "::1",
    "[fc00::1]", "[fd12:3456::1]", "[fe80::1]", "[::ffff:7f00:1]", "printer.local", "db.internal",
    "host.internal.",
  ])("refuses %s", (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });

  it.each(["docs.example.com", "172.32.0.1", "172.15.0.1", "11.0.0.1", "192.169.0.1", "internal.example.com", "10.example.com", "[2606:4700::1111]"])(
    "allows %s",
    (host) => {
      expect(isPrivateHost(host)).toBe(false);
    }
  );

  it("url_fetch refuses an allowlisted URL on a private host without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(config.isAllowed).mockReturnValue(true);

    const result = await callToolHandler(config, "url_fetch", { url: "https://169.254.169.254/latest/meta-data" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("refusing private or local host");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// redirects
// ---------------------------------------------------------------------------

describe("url_fetch redirects", () => {
  const redirect = (location?: string) => ({
    ok: false,
    status: 302,
    statusText: "Found",
    headers: { get: (h: string) => (h === "location" ? location ?? null : null) },
  });
  const page = { ok: true, status: 200, headers: { get: () => "text/plain" }, text: async () => "final page" };

  it("fetches with redirect: manual", async () => {
    const fetchMock = vi.fn().mockResolvedValue(page);
    vi.stubGlobal("fetch", fetchMock);
    await callToolHandler(config, "url_fetch", { url: "https://docs.example.com" });
    expect(fetchMock.mock.calls[0][1].redirect).toBe("manual");
  });

  it("refuses a redirect to a URL that is not allowlisted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(redirect("https://evil.com/steal"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await callToolHandler(config, "url_fetch", { url: "https://docs.example.com" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("https://evil.com/steal is not on the allowlist");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a 3xx with no Location header", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(redirect()));
    const result = await callToolHandler(config, "url_fetch", { url: "https://docs.example.com" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no Location header");
  });

  it("follows one redirect to an allowlisted URL, resolving a relative Location", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(redirect("/guide")).mockResolvedValueOnce(page);
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(config.isAllowed).mockImplementation((u: string) => u.startsWith("https://docs.example.com"));
    const result = await callToolHandler(config, "url_fetch", { url: "https://docs.example.com" });
    expect(fetchMock.mock.calls[1][0]).toBe("https://docs.example.com/guide");
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("final page");
  });

  it("refuses a second redirect", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(redirect("https://docs.example.com/a"))
      .mockResolvedValueOnce(redirect("https://docs.example.com/b"));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(config.isAllowed).mockImplementation((u: string) => u.startsWith("https://docs.example.com"));
    const result = await callToolHandler(config, "url_fetch", { url: "https://docs.example.com" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Too many redirects");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("fetchAllowed", () => {
  it("refuses a URL that is not allowlisted without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchAllowed(config, "https://evil.com/")).rejects.toThrow("not on allowlist");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the response for an allowlisted URL, including non-ok statuses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 503 })));
    const res = await fetchAllowed(config, "https://docs.example.com");
    expect(res.status).toBe(503);
  });
});
