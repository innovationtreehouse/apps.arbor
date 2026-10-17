import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UrlStore, ConfigStore, AuditStore, UrlEntry, AuditRecord } from "@arbor/db";

// ---------------------------------------------------------------------------
// Shared mock stores
// ---------------------------------------------------------------------------

const mockUrlStore: UrlStore = {
  listEnabled: vi.fn(),
  listAll: vi.fn(),
  upsert: vi.fn(),
  delete: vi.fn(),
  count: vi.fn(),
};

const mockConfigStore: ConfigStore = {
  get: vi.fn(),
  set: vi.fn(),
};

const mockAuditStore: AuditStore = {
  write: vi.fn(),
  listRecent: vi.fn(),
  listByThread: vi.fn(),
};

const stores = { urlStore: mockUrlStore, configStore: mockConfigStore, auditStore: mockAuditStore };

// Capture what gets POSTed to response_url
let postedResponse: { response_type: string; text: string } | null = null;

const RESPONSE_URL = "https://hooks.slack.com/test";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
  postedResponse = null;
  // Default fetch: capture response_url posts, reject anything else
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === RESPONSE_URL) {
      if (init?.body) postedResponse = JSON.parse(init.body as string);
      return { ok: true };
    }
    return Promise.reject(new Error(`Unexpected fetch to ${url}`));
  });
});

const { processAdminCommand } = await import("../admin.js");

async function runCommand(subcommand: string, args: string[] = [], userId = "U_ADMIN"): Promise<string> {
  await processAdminCommand(
    { type: "admin_command", subcommand, args, userId, responseUrl: RESPONSE_URL },
    stores
  );
  return postedResponse?.text ?? "";
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("list", () => {
  it("shows empty message when no URLs configured", async () => {
    vi.mocked(mockUrlStore.listAll).mockResolvedValueOnce([]);
    const text = await runCommand("list");
    expect(text).toContain("No URLs configured");
  });

  it("shows configured URLs", async () => {
    const item: UrlEntry = { url: "https://example.com", description: "Example", added_by: "U1", enabled: true, added_at: "" };
    vi.mocked(mockUrlStore.listAll).mockResolvedValueOnce([item]);
    const text = await runCommand("list");
    expect(text).toContain("https://example.com");
    expect(text).toContain("Example");
  });

  it("shows enabled/disabled status", async () => {
    const items: UrlEntry[] = [
      { url: "https://a.com", description: "A", added_by: "U1", enabled: true, added_at: "" },
      { url: "https://b.com", description: "B", added_by: "U1", enabled: false, added_at: "" },
    ];
    vi.mocked(mockUrlStore.listAll).mockResolvedValueOnce(items);
    const text = await runCommand("list");
    expect(text).toContain("✅");
    expect(text).toContain("❌");
  });
});

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

describe("add", () => {
  it("rejects missing description", async () => {
    const text = await runCommand("add", ["https://example.com"]);
    expect(text).toContain("Usage:");
  });

  it("rejects non-https URL", async () => {
    const text = await runCommand("add", ["http://example.com", "My site"]);
    expect(text).toContain("must start with");
  });

  it("rejects when URL limit reached", async () => {
    vi.mocked(mockUrlStore.count).mockResolvedValueOnce(100);
    const text = await runCommand("add", ["https://new.com", "New site"]);
    expect(text).toContain("limit");
  });

  it("stores a valid URL", async () => {
    vi.mocked(mockUrlStore.count).mockResolvedValueOnce(0);
    const text = await runCommand("add", ["https://docs.example.com", "Our", "API", "docs"], "U_ADMIN");
    expect(text).toContain("Added");
    expect(text).toContain("https://docs.example.com*");
    expect(mockUrlStore.upsert).toHaveBeenCalledWith({
      url: "https://docs.example.com*",
      description: "Our API docs",
      added_by: "U_ADMIN",
      enabled: true,
    });
  });
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

describe("remove", () => {
  it("rejects missing URL argument", async () => {
    const text = await runCommand("remove", []);
    expect(text).toContain("Usage:");
  });

  it("deletes the URL", async () => {
    vi.mocked(mockUrlStore.delete).mockResolvedValueOnce(undefined);
    const text = await runCommand("remove", ["https://docs.example.com"]);
    expect(text).toContain("Removed");
    expect(mockUrlStore.delete).toHaveBeenCalledWith("https://docs.example.com");
  });
});

// ---------------------------------------------------------------------------
// test
// ---------------------------------------------------------------------------

describe("test", () => {
  it("rejects missing URL argument", async () => {
    const text = await runCommand("test", []);
    expect(text).toContain("Usage:");
  });

  it("rejects non-https URL", async () => {
    const text = await runCommand("test", ["http://bad.com"]);
    expect(text).toContain("must start with");
  });

  it("returns preview on successful fetch", async () => {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === RESPONSE_URL) {
        if (init?.body) postedResponse = JSON.parse(init.body as string);
        return { ok: true };
      }
      return { ok: true, status: 200, text: async () => "Hello world content" };
    });
    const text = await runCommand("test", ["https://example.com"]);
    expect(text).toContain("reachable");
    expect(text).toContain("Hello world content");
  });

  it("reports HTTP error status", async () => {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === RESPONSE_URL) {
        if (init?.body) postedResponse = JSON.parse(init.body as string);
        return { ok: true };
      }
      return { ok: false, status: 404, statusText: "Not Found" };
    });
    const text = await runCommand("test", ["https://example.com"]);
    expect(text).toContain("404");
  });

  it("reports network error", async () => {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === RESPONSE_URL) {
        if (init?.body) postedResponse = JSON.parse(init.body as string);
        return { ok: true };
      }
      throw new Error("ECONNREFUSED");
    });
    const text = await runCommand("test", ["https://example.com"]);
    expect(text).toContain("ECONNREFUSED");
  });
});

// ---------------------------------------------------------------------------
// model
// ---------------------------------------------------------------------------

describe("model", () => {
  it("shows current model", async () => {
    vi.mocked(mockConfigStore.get).mockResolvedValueOnce("anthropic/claude-opus-4.6");
    const text = await runCommand("model", []);
    expect(text).toContain("anthropic/claude-opus-4.6");
    expect(text).not.toContain("⚠️");
  });

  it("warns when the stored model is a pre-OpenRouter ID", async () => {
    vi.mocked(mockConfigStore.get).mockResolvedValueOnce("claude-opus-4-6");
    const text = await runCommand("model", []);
    expect(text).toContain("Not an OpenRouter model ID");
  });

  it("rejects a model ID without a provider prefix", async () => {
    const text = await runCommand("model", ["claude-haiku-4-5-20251001"]);
    expect(text).toContain("❌");
    expect(mockConfigStore.set).not.toHaveBeenCalled();
  });

  it("shows default when no model set", async () => {
    vi.mocked(mockConfigStore.get).mockResolvedValueOnce(undefined);
    const text = await runCommand("model", []);
    expect(text).toContain("default");
  });

  it("sets model when argument provided", async () => {
    const text = await runCommand("model", ["anthropic/claude-haiku-4.5"]);
    expect(text).toContain("anthropic/claude-haiku-4.5");
    expect(mockConfigStore.set).toHaveBeenCalledWith("model", "anthropic/claude-haiku-4.5");
  });
});

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

describe("audit", () => {
  it("shows empty message when no records", async () => {
    vi.mocked(mockAuditStore.listRecent).mockResolvedValueOnce([]);
    const text = await runCommand("audit", []);
    expect(text).toContain("No audit records");
  });

  it("lists recent records", async () => {
    const record: AuditRecord = {
      id: 1, channel: "C_TEST", thread_ts: "1.0", user_id: "U_USER",
      prompt: "What is the plan?", response: "The plan is...",
      model: "claude-opus-4-6", duration_ms: 2500, created_at: "2026-03-23T10:00:00.000Z",
    };
    vi.mocked(mockAuditStore.listRecent).mockResolvedValueOnce([record]);
    const text = await runCommand("audit", []);
    expect(text).toContain("U_USER");
    expect(text).toContain("C_TEST");
    expect(text).toContain("2500ms");
    expect(mockAuditStore.listRecent).toHaveBeenCalledWith(10);
  });

  it("respects custom limit, capped at 50", async () => {
    vi.mocked(mockAuditStore.listRecent).mockResolvedValue([]);
    await runCommand("audit", ["20"]);
    expect(mockAuditStore.listRecent).toHaveBeenCalledWith(20);
    await runCommand("audit", ["100"]);
    expect(mockAuditStore.listRecent).toHaveBeenCalledWith(50);
  });
});

// ---------------------------------------------------------------------------
// audit-thread
// ---------------------------------------------------------------------------

describe("audit-thread", () => {
  it("rejects missing arguments", async () => {
    const text = await runCommand("audit-thread", ["C1"]);
    expect(text).toContain("Usage:");
  });

  it("shows empty message when no records", async () => {
    vi.mocked(mockAuditStore.listByThread).mockResolvedValueOnce([]);
    const text = await runCommand("audit-thread", ["C1", "1.0"]);
    expect(text).toContain("No audit records");
  });

  it("shows records for specified thread", async () => {
    const record: AuditRecord = {
      id: 2, channel: "C1", thread_ts: "1.0", user_id: "U_USER",
      prompt: "Summarize this", response: "Summary: ...",
      model: null, duration_ms: 1200, created_at: "2026-03-23T11:00:00.000Z",
    };
    vi.mocked(mockAuditStore.listByThread).mockResolvedValueOnce([record]);
    const text = await runCommand("audit-thread", ["C1", "1.0"]);
    expect(text).toContain("Summarize this");
    expect(text).toContain("Summary:");
    expect(mockAuditStore.listByThread).toHaveBeenCalledWith("C1", "1.0");
  });
});

// ---------------------------------------------------------------------------
// token-limit
// ---------------------------------------------------------------------------

describe("token-limit", () => {
  it("shows unlimited when no default set", async () => {
    vi.mocked(mockConfigStore.get).mockResolvedValueOnce(undefined);
    const text = await runCommand("token-limit", []);
    expect(text).toContain("unlimited");
  });

  it("shows current default", async () => {
    vi.mocked(mockConfigStore.get).mockResolvedValueOnce("4096");
    const text = await runCommand("token-limit", []);
    expect(text).toContain("4096");
  });

  it("sets default limit", async () => {
    const text = await runCommand("token-limit", ["default", "4096"]);
    expect(text).toContain("4096");
    expect(mockConfigStore.set).toHaveBeenCalledWith("token_limit:default", "4096");
  });

  it("sets per-channel limit", async () => {
    const text = await runCommand("token-limit", ["C_GENERAL", "2048"]);
    expect(text).toContain("2048");
    expect(mockConfigStore.set).toHaveBeenCalledWith("token_limit:C_GENERAL", "2048");
  });

  it("shows unlimited when channel has no limit", async () => {
    vi.mocked(mockConfigStore.get).mockResolvedValueOnce(undefined);
    const text = await runCommand("token-limit", ["C_GENERAL"]);
    expect(text).toContain("unlimited");
  });

  it("rejects non-positive limit", async () => {
    const text = await runCommand("token-limit", ["default", "0"]);
    expect(text).toContain("positive integer");
    expect(mockConfigStore.set).not.toHaveBeenCalled();
  });

  it("rejects non-numeric limit", async () => {
    const text = await runCommand("token-limit", ["default", "banana"]);
    expect(text).toContain("positive integer");
  });
});

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

describe("check", () => {
  const validCreds = JSON.stringify({
    client_email: "bot@project.iam.gserviceaccount.com",
    private_key: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4VTReXRIcKGdFpWiosmXWZAhVVh\n-----END RSA PRIVATE KEY-----\n",
    project_id: "my-project",
  });

  beforeEach(() => {
    delete process.env.GOOGLE_CREDENTIALS;
    delete process.env.GITHUB_TOKEN;
    delete process.env.OPENROUTER_API_KEY;
  });

  function makeCheckFetch(overrides: Record<string, () => Promise<unknown>> = {}) {
    return async (url: string, init?: RequestInit): Promise<unknown> => {
      if (url === RESPONSE_URL) {
        if (init?.body) postedResponse = JSON.parse(init.body as string);
        return { ok: true };
      }
      if (overrides[url]) return overrides[url]();
      return Promise.reject(new Error(`Unexpected fetch to ${url}`));
    };
  }

  it("reports missing GOOGLE_CREDENTIALS", async () => {
    vi.mocked(mockUrlStore.count).mockResolvedValueOnce(0);
    mockFetch.mockImplementation(makeCheckFetch());
    const text = await runCommand("check");
    expect(text).toContain("GOOGLE_CREDENTIALS");
    expect(text).toContain("not set");
  });

  it("reports invalid JSON in GOOGLE_CREDENTIALS", async () => {
    process.env.GOOGLE_CREDENTIALS = "not-json";
    vi.mocked(mockUrlStore.count).mockResolvedValueOnce(0);
    mockFetch.mockImplementation(makeCheckFetch());
    const text = await runCommand("check");
    expect(text).toContain("not valid JSON");
  });

  it("reports missing fields in GOOGLE_CREDENTIALS", async () => {
    process.env.GOOGLE_CREDENTIALS = JSON.stringify({ client_email: "x@y.com" });
    vi.mocked(mockUrlStore.count).mockResolvedValueOnce(0);
    mockFetch.mockImplementation(makeCheckFetch());
    const text = await runCommand("check");
    expect(text).toMatch(/missing fields/);
  });

  it("reports Google Drive error (bad key causes crypto failure)", async () => {
    process.env.GOOGLE_CREDENTIALS = validCreds;
    vi.mocked(mockUrlStore.count).mockResolvedValueOnce(0);
    mockFetch.mockImplementation(makeCheckFetch());
    const text = await runCommand("check");
    // The fake private key causes a crypto error before the HTTP call
    expect(text).toMatch(/❌ \*Google Drive\*/);
  });

  it("reports Google Drive auth failure from API", async () => {
    // Use a real RSA key structure so the JWT signing succeeds, but mock the token endpoint to fail
    const { generateKeyPairSync } = await import("crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const realCreds = JSON.stringify({
      client_email: "bot@project.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      project_id: "my-project",
    });
    process.env.GOOGLE_CREDENTIALS = realCreds;
    vi.mocked(mockUrlStore.count).mockResolvedValueOnce(0);
    mockFetch.mockImplementation(makeCheckFetch({
      "https://oauth2.googleapis.com/token": async () => ({
        ok: false, status: 401, text: async () => "invalid_grant",
      }),
    }));
    const text = await runCommand("check");
    expect(text).toContain("auth failed");
  });

  it("reports missing GITHUB_TOKEN", async () => {
    process.env.GOOGLE_CREDENTIALS = validCreds;
    vi.mocked(mockUrlStore.count).mockResolvedValueOnce(0);
    mockFetch.mockImplementation(makeCheckFetch({
      "https://oauth2.googleapis.com/token": async () => ({ ok: true, json: async () => ({ access_token: "tok" }) }),
      "https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id,name)": async () => ({ ok: true, json: async () => ({ files: [] }) }),
    }));
    const text = await runCommand("check");
    expect(text).toContain("GITHUB_TOKEN");
    expect(text).toContain("not set");
  });

  it("reports GitHub auth success", async () => {
    process.env.GOOGLE_CREDENTIALS = validCreds;
    process.env.GITHUB_TOKEN = "ghp_test";
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    vi.mocked(mockUrlStore.count).mockResolvedValueOnce(3);
    mockFetch.mockImplementation(makeCheckFetch({
      "https://oauth2.googleapis.com/token": async () => ({ ok: true, json: async () => ({ access_token: "tok" }) }),
      "https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id,name)": async () => ({ ok: true, json: async () => ({ files: [{ id: "1", name: "doc" }] }) }),
      "https://api.github.com/user": async () => ({ ok: true, json: async () => ({ login: "jeff" }) }),
    }));
    const text = await runCommand("check");
    expect(text).toContain("GitHub");
    expect(text).toContain("jeff");
    expect(text).toContain("3 URLs");
  });

  it("reports DB error in URL fetcher check", async () => {
    vi.mocked(mockUrlStore.count).mockRejectedValueOnce(new Error("connection refused"));
    mockFetch.mockImplementation(makeCheckFetch());
    const text = await runCommand("check");
    expect(text).toContain("database error");
    expect(text).toContain("connection refused");
  });

  it("reports unknown OPENROUTER_API_KEY format", async () => {
    process.env.OPENROUTER_API_KEY = "not-a-real-key";
    vi.mocked(mockUrlStore.count).mockResolvedValueOnce(0);
    mockFetch.mockImplementation(makeCheckFetch());
    const text = await runCommand("check");
    expect(text).toContain("format looks unexpected");
  });

  it("reports missing OPENROUTER_API_KEY", async () => {
    vi.mocked(mockUrlStore.count).mockResolvedValueOnce(0);
    mockFetch.mockImplementation(makeCheckFetch());
    const text = await runCommand("check");
    expect(text).toContain("OPENROUTER_API_KEY");
    expect(text).toContain("❌");
  });
});

// ---------------------------------------------------------------------------
// prompt
// ---------------------------------------------------------------------------

describe("prompt", () => {
  it("show with no args shows both prompts", async () => {
    vi.mocked(mockConfigStore.get).mockResolvedValue(undefined);
    const text = await runCommand("prompt", ["show"]);
    expect(text).toContain("System prompt");
    expect(text).toContain("User prompt template");
    expect(text).toContain("default (from code)");
  });

  it("show is the default subcommand", async () => {
    vi.mocked(mockConfigStore.get).mockResolvedValue(undefined);
    const text = await runCommand("prompt", []);
    expect(text).toContain("System prompt");
    expect(text).toContain("User prompt template");
  });

  it("show system shows only system prompt", async () => {
    vi.mocked(mockConfigStore.get).mockResolvedValueOnce("Custom system.");
    const text = await runCommand("prompt", ["show", "system"]);
    expect(text).toContain("System prompt");
    expect(text).toContain("custom override");
    expect(text).not.toContain("User prompt template");
  });

  it("show user shows only user prompt template", async () => {
    vi.mocked(mockConfigStore.get).mockResolvedValueOnce(undefined);
    const text = await runCommand("prompt", ["show", "user"]);
    expect(text).toContain("User prompt template");
    expect(text).not.toContain("System prompt");
  });

  it("shows custom override when set", async () => {
    vi.mocked(mockConfigStore.get).mockResolvedValueOnce("You are a custom bot.");
    const text = await runCommand("prompt", ["show", "system"]);
    expect(text).toContain("custom override");
    expect(text).toContain("You are a custom bot.");
  });

  it("sets system prompt", async () => {
    const text = await runCommand("prompt", ["set", "system", "You", "are", "a", "test", "bot."]);
    expect(text).toContain("✅");
    expect(mockConfigStore.set).toHaveBeenCalledWith("prompt:system", "You are a test bot.");
  });

  it("sets user prompt template", async () => {
    const text = await runCommand("prompt", ["set", "user", "CTX:{{context}}", "MSG:{{message}}"]);
    expect(text).toContain("✅");
    expect(mockConfigStore.set).toHaveBeenCalledWith("prompt:user", "CTX:{{context}} MSG:{{message}}");
  });

  it("rejects set with missing target", async () => {
    const text = await runCommand("prompt", ["set"]);
    expect(text).toContain("Usage:");
  });

  it("rejects set with invalid target", async () => {
    const text = await runCommand("prompt", ["set", "banana", "some text"]);
    expect(text).toContain("Usage:");
  });

  it("rejects set with valid target but no text", async () => {
    const text = await runCommand("prompt", ["set", "system"]);
    expect(text).toContain("Usage:");
  });

  it("resets system prompt only", async () => {
    const text = await runCommand("prompt", ["reset", "system"]);
    expect(text).toContain("✅");
    expect(mockConfigStore.set).toHaveBeenCalledWith("prompt:system", "");
    expect(mockConfigStore.set).toHaveBeenCalledTimes(1);
    expect(text).toContain("Google Drive");
  });

  it("resets user prompt only", async () => {
    const text = await runCommand("prompt", ["reset", "user"]);
    expect(text).toContain("✅");
    expect(mockConfigStore.set).toHaveBeenCalledWith("prompt:user", "");
    expect(mockConfigStore.set).toHaveBeenCalledTimes(1);
    expect(text).toContain("{{context}}");
  });

  it("resets both prompts when no target given", async () => {
    const text = await runCommand("prompt", ["reset"]);
    expect(text).toContain("✅");
    expect(mockConfigStore.set).toHaveBeenCalledWith("prompt:system", "");
    expect(mockConfigStore.set).toHaveBeenCalledWith("prompt:user", "");
    expect(text).toContain("Google Drive");
    expect(text).toContain("{{context}}");
  });

  it("rejects reset with invalid target", async () => {
    const text = await runCommand("prompt", ["reset", "banana"]);
    expect(text).toContain("Unknown prompt target");
  });

  it("returns error for unknown subcommand", async () => {
    const text = await runCommand("prompt", ["frobnicate"]);
    expect(text).toContain("Unknown prompt subcommand");
    expect(text).toContain("show");
    expect(text).toContain("set");
    expect(text).toContain("reset");
  });
});

// ---------------------------------------------------------------------------
// channel-messages
// ---------------------------------------------------------------------------

describe("channel-messages", () => {
  it("shows off status when not set", async () => {
    vi.mocked(mockConfigStore.get).mockResolvedValueOnce(undefined);
    const text = await runCommand("channel-messages", []);
    expect(text).toContain("off");
    expect(text).toContain("default");
  });

  it("shows on status when enabled", async () => {
    vi.mocked(mockConfigStore.get).mockResolvedValueOnce("on");
    const text = await runCommand("channel-messages", []);
    expect(text).toContain("on");
  });

  it("turns channel messages on", async () => {
    const text = await runCommand("channel-messages", ["on"]);
    expect(text).toContain("on");
    expect(mockConfigStore.set).toHaveBeenCalledWith("channel_messages", "on");
  });

  it("turns channel messages off", async () => {
    const text = await runCommand("channel-messages", ["off"]);
    expect(text).toContain("off");
    expect(mockConfigStore.set).toHaveBeenCalledWith("channel_messages", "off");
  });

  it("rejects invalid setting", async () => {
    const text = await runCommand("channel-messages", ["maybe"]);
    expect(text).toContain("Usage:");
    expect(mockConfigStore.set).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------

describe("version", () => {
  beforeEach(() => {
    delete process.env.GIT_SHA;
    delete process.env.DEPLOY_TAG;
    delete process.env.DEPLOY_DIFF_URL;
  });

  it("reports unavailable when GIT_SHA not set", async () => {
    const text = await runCommand("version");
    expect(text).toContain("not available");
  });

  it("shows sha slice as version when only GIT_SHA is set", async () => {
    process.env.GIT_SHA = "abcdef1234567890abcdef1234567890abcdef12";
    const text = await runCommand("version");
    expect(text).toContain("abcdef12");
    expect(text).toContain("abcdef1234567890abcdef1234567890abcdef12");
    expect(text).not.toContain("Changes since");
  });

  it("shows DEPLOY_TAG as version when set", async () => {
    process.env.GIT_SHA = "abcdef1234567890abcdef1234567890abcdef12";
    process.env.DEPLOY_TAG = "prod-20260410-abcdef12";
    const text = await runCommand("version");
    expect(text).toContain("prod-20260410-abcdef12");
  });

  it("includes diff URL when DEPLOY_DIFF_URL is set", async () => {
    process.env.GIT_SHA = "abcdef1234567890abcdef1234567890abcdef12";
    process.env.DEPLOY_TAG = "prod-20260410-abcdef12";
    process.env.DEPLOY_DIFF_URL = "https://github.com/org/repo/compare/prev...abcdef12";
    const text = await runCommand("version");
    expect(text).toContain("Changes since last promotion");
    expect(text).toContain("https://github.com/org/repo/compare/prev...abcdef12");
  });
});

// ---------------------------------------------------------------------------
// unknown subcommand + error handling
// ---------------------------------------------------------------------------

describe("unknown subcommand", () => {
  it("returns unknown subcommand message", async () => {
    const text = await runCommand("frobnicate", []);
    expect(text).toContain("Unknown subcommand");
    expect(text).toContain("frobnicate");
  });
});

describe("error handling", () => {
  it("catches errors and posts error message to response_url", async () => {
    vi.mocked(mockUrlStore.listAll).mockRejectedValueOnce(new Error("DB exploded"));
    const text = await runCommand("list");
    expect(text).toContain("Command failed");
    expect(text).toContain("DB exploded");
  });
});
