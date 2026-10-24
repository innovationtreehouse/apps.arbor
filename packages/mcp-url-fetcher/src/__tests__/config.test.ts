import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UrlStore, UrlEntry } from "@arbor/db";
import { UrlConfig, prefixMatches } from "../config.js";

const ENABLED_ITEM: UrlEntry = {
  url: "https://docs.example.com",
  description: "API Docs",
  enabled: true,
  added_by: "U1",
  added_at: "2026-01-01T00:00:00.000Z",
};

const WILDCARD_ITEM: UrlEntry = {
  url: "https://wiki.example.com/*",
  description: "Company Wiki",
  enabled: true,
  added_by: "U1",
  added_at: "2026-01-01T00:00:00.000Z",
};

const DISABLED_ITEM: UrlEntry = {
  url: "https://old.example.com",
  description: "Old Docs",
  enabled: false,
  added_by: "U1",
  added_at: "2026-01-01T00:00:00.000Z",
};

function makeStore(overrides?: Partial<UrlStore>): UrlStore {
  return {
    listEnabled: vi.fn().mockResolvedValue([]),
    listAll: vi.fn().mockResolvedValue([]),
    upsert: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    count: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

describe("UrlConfig.load", () => {
  it("loads enabled URLs from the store", async () => {
    const store = makeStore({ listEnabled: vi.fn().mockResolvedValue([ENABLED_ITEM]) });
    const config = new UrlConfig(store);
    await config.load();
    expect(config.isAllowed("https://docs.example.com")).toBe(true);
  });

  it("does not expose disabled URLs (store filters them)", async () => {
    // The store's listEnabled returns only enabled entries;
    // a disabled item returned here would be a store bug, but UrlConfig
    // trusts whatever listEnabled returns.
    const store = makeStore({ listEnabled: vi.fn().mockResolvedValue([]) });
    const config = new UrlConfig(store);
    await config.load();
    expect(config.isAllowed("https://old.example.com")).toBe(false);
  });

  it("handles an empty result", async () => {
    const store = makeStore();
    const config = new UrlConfig(store);
    await config.load();
    expect(config.getAll()).toHaveLength(0);
  });
});

describe("UrlConfig.isAllowed", () => {
  it("returns true for a URL in the allowlist", async () => {
    const store = makeStore({ listEnabled: vi.fn().mockResolvedValue([ENABLED_ITEM]) });
    const config = new UrlConfig(store);
    await config.load();
    expect(config.isAllowed("https://docs.example.com")).toBe(true);
  });

  it("returns false for a URL not in the allowlist", async () => {
    const store = makeStore();
    const config = new UrlConfig(store);
    await config.load();
    expect(config.isAllowed("https://unknown.com")).toBe(false);
  });

  it("is case-sensitive", async () => {
    const store = makeStore({ listEnabled: vi.fn().mockResolvedValue([ENABLED_ITEM]) });
    const config = new UrlConfig(store);
    await config.load();
    expect(config.isAllowed("https://DOCS.EXAMPLE.COM")).toBe(false);
  });

  it("allows a URL matching a wildcard prefix", async () => {
    const store = makeStore({ listEnabled: vi.fn().mockResolvedValue([WILDCARD_ITEM]) });
    const config = new UrlConfig(store);
    await config.load();
    expect(config.isAllowed("https://wiki.example.com/some/page")).toBe(true);
    expect(config.isAllowed("https://wiki.example.com/")).toBe(true);
  });

  it("does not allow a URL from a different domain when only a wildcard prefix is stored", async () => {
    const store = makeStore({ listEnabled: vi.fn().mockResolvedValue([WILDCARD_ITEM]) });
    const config = new UrlConfig(store);
    await config.load();
    expect(config.isAllowed("https://other.example.com/page")).toBe(false);
  });
});

describe("UrlConfig.getAll", () => {
  it("returns all loaded entries", async () => {
    const store = makeStore({ listEnabled: vi.fn().mockResolvedValue([ENABLED_ITEM]) });
    const config = new UrlConfig(store);
    await config.load();
    const all = config.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].url).toBe("https://docs.example.com");
    expect(all[0].description).toBe("API Docs");
  });
});

describe("UrlConfig.getDescription", () => {
  it("returns the description for a known URL", async () => {
    const store = makeStore({ listEnabled: vi.fn().mockResolvedValue([ENABLED_ITEM]) });
    const config = new UrlConfig(store);
    await config.load();
    expect(config.getDescription("https://docs.example.com")).toBe("API Docs");
  });

  it("returns empty string for unknown URL", async () => {
    const store = makeStore();
    const config = new UrlConfig(store);
    await config.load();
    expect(config.getDescription("https://unknown.com")).toBe("");
  });

  it("returns the description for a URL matching a wildcard prefix", async () => {
    const store = makeStore({ listEnabled: vi.fn().mockResolvedValue([WILDCARD_ITEM]) });
    const config = new UrlConfig(store);
    await config.load();
    expect(config.getDescription("https://wiki.example.com/some/page")).toBe("Company Wiki");
  });
});

describe("UrlConfig.startPolling", () => {
  it("refreshes the allowlist on the poll interval", async () => {
    vi.useFakeTimers();
    process.env.URL_POLL_INTERVAL_S = "1";

    const listEnabled = vi.fn()
      .mockResolvedValueOnce([ENABLED_ITEM])
      .mockResolvedValueOnce([
        ENABLED_ITEM,
        { ...ENABLED_ITEM, url: "https://new.example.com", description: "New" },
      ]);
    const store = makeStore({ listEnabled });
    const config = new UrlConfig(store);
    await config.load();

    config.startPolling();
    await vi.advanceTimersByTimeAsync(1100);

    expect(config.isAllowed("https://new.example.com")).toBe(true);

    vi.useRealTimers();
    delete process.env.URL_POLL_INTERVAL_S;
  });
});

describe("prefixMatches", () => {
  it.each([
    ["https://example.com", "https://example.com/", true],
    ["https://example.com", "https://example.com/a/b?c=1", true],
    ["https://example.com", "https://example.com.evil.com/", false],
    ["https://example.com", "https://example.com@evil.com/", false],
    ["https://example.com", "http://example.com/", false],
    ["https://example.com/docs", "https://example.com/docs", true],
    ["https://example.com/docs", "https://example.com/docs/page", true],
    ["https://example.com/docs", "https://example.com/docs?x=1", true],
    ["https://example.com/docs", "https://example.com/docs-evil", false],
    ["https://example.com/docs/", "https://example.com/docs/page", true],
    ["https://example.com/docs/", "https://example.com/docsx", false],
    ["not a url", "https://example.com/", false],
  ])("%s* vs %s -> %s", (prefix, url, expected) => {
    expect(prefixMatches(prefix, url)).toBe(expected);
  });

  it("is what isAllowed uses for wildcard entries", async () => {
    const store = makeStore({ listEnabled: vi.fn().mockResolvedValue([{ ...WILDCARD_ITEM, url: "https://example.com*" }]) });
    const config = new UrlConfig(store);
    await config.load();
    expect(config.isAllowed("https://example.com/page")).toBe(true);
    expect(config.isAllowed("https://example.com.evil.com/")).toBe(false);
  });
});
