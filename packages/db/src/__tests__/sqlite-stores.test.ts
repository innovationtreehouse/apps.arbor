import { describe, it, expect, beforeEach, vi } from "vitest";
import { createStores } from "../create-stores.js";
import type { StoreSet } from "../create-stores.js";
import postgres from "postgres";

// Wrap the real (lazy, non-connecting) postgres() so tests can count clients.
vi.mock("postgres", async (importOriginal) => {
  const real = (await importOriginal<typeof import("postgres")>()).default;
  return { default: vi.fn(real) };
});

// Use an in-memory SQLite database for each test run
let stores: StoreSet;

beforeEach(() => {
  stores = createStores(":memory:");
});

// ---------------------------------------------------------------------------
// SqliteUrlStore
// ---------------------------------------------------------------------------

describe("SqliteUrlStore", () => {
  it("listEnabled returns empty array initially", async () => {
    expect(await stores.urlStore.listEnabled()).toEqual([]);
  });

  it("upsert inserts a URL and listAll returns it", async () => {
    await stores.urlStore.upsert({
      url: "https://example.com",
      description: "Example",
      added_by: "U1",
      enabled: true,
    });
    const all = await stores.urlStore.listAll();
    expect(all).toHaveLength(1);
    expect(all[0].url).toBe("https://example.com");
    expect(all[0].description).toBe("Example");
    expect(all[0].enabled).toBe(true);
  });

  it("upsert updates an existing URL", async () => {
    await stores.urlStore.upsert({ url: "https://a.com", description: "A", added_by: "U1", enabled: true });
    await stores.urlStore.upsert({ url: "https://a.com", description: "A updated", added_by: "U2", enabled: false });
    const all = await stores.urlStore.listAll();
    expect(all).toHaveLength(1);
    expect(all[0].description).toBe("A updated");
    expect(all[0].enabled).toBe(false);
  });

  it("listEnabled filters out disabled URLs", async () => {
    await stores.urlStore.upsert({ url: "https://on.com", description: "On", added_by: "U1", enabled: true });
    await stores.urlStore.upsert({ url: "https://off.com", description: "Off", added_by: "U1", enabled: false });
    const enabled = await stores.urlStore.listEnabled();
    expect(enabled).toHaveLength(1);
    expect(enabled[0].url).toBe("https://on.com");
  });

  it("delete removes a URL", async () => {
    await stores.urlStore.upsert({ url: "https://del.com", description: "Del", added_by: "U1", enabled: true });
    await stores.urlStore.delete("https://del.com");
    expect(await stores.urlStore.listAll()).toHaveLength(0);
  });

  it("count returns the number of entries", async () => {
    expect(await stores.urlStore.count()).toBe(0);
    await stores.urlStore.upsert({ url: "https://a.com", description: "A", added_by: "U1", enabled: true });
    await stores.urlStore.upsert({ url: "https://b.com", description: "B", added_by: "U1", enabled: true });
    expect(await stores.urlStore.count()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// SqliteConfigStore
// ---------------------------------------------------------------------------

describe("SqliteConfigStore", () => {
  it("get returns undefined for missing key", async () => {
    expect(await stores.configStore.get("model")).toBeUndefined();
  });

  it("set and get roundtrip", async () => {
    await stores.configStore.set("model", "claude-opus-4-6");
    expect(await stores.configStore.get("model")).toBe("claude-opus-4-6");
  });

  it("set overwrites existing value", async () => {
    await stores.configStore.set("model", "claude-opus-4-6");
    await stores.configStore.set("model", "claude-haiku-4-5-20251001");
    expect(await stores.configStore.get("model")).toBe("claude-haiku-4-5-20251001");
  });
});

// ---------------------------------------------------------------------------
// SqliteAuditStore
// ---------------------------------------------------------------------------

describe("SqliteAuditStore", () => {
  const record = {
    channel: "C1",
    thread_ts: "1.0",
    user_id: "U1",
    prompt: "What is 2+2?",
    response: "4",
    model: "claude-opus-4-6",
    duration_ms: 500,
  };

  it("listRecent returns empty array initially", async () => {
    expect(await stores.auditStore.listRecent(10)).toEqual([]);
  });

  it("write and listRecent roundtrip", async () => {
    await stores.auditStore.write(record);
    const rows = await stores.auditStore.listRecent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe("C1");
    expect(rows[0].user_id).toBe("U1");
    expect(rows[0].duration_ms).toBe(500);
    expect(rows[0].id).toBeTypeOf("number");
    expect(rows[0].created_at).toBeTypeOf("string");
  });

  it("write accepts null model", async () => {
    await stores.auditStore.write({ ...record, model: null });
    const rows = await stores.auditStore.listRecent(10);
    expect(rows[0].model).toBeNull();
  });

  it("listRecent respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await stores.auditStore.write({ ...record, prompt: `prompt ${i}` });
    }
    expect(await stores.auditStore.listRecent(3)).toHaveLength(3);
  });

  it("listByThread filters by channel and thread_ts", async () => {
    await stores.auditStore.write({ ...record, channel: "C1", thread_ts: "1.0" });
    await stores.auditStore.write({ ...record, channel: "C1", thread_ts: "2.0" });
    await stores.auditStore.write({ ...record, channel: "C2", thread_ts: "1.0" });
    const rows = await stores.auditStore.listByThread("C1", "1.0");
    expect(rows).toHaveLength(1);
    expect(rows[0].thread_ts).toBe("1.0");
    expect(rows[0].channel).toBe("C1");
  });

  it("breaks created_at ties by id, newest first", async () => {
    vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z"), toFake: ["Date"] });
    try {
      await stores.auditStore.write({ ...record, prompt: "first" });
      await stores.auditStore.write({ ...record, prompt: "second" });
    } finally {
      vi.useRealTimers();
    }
    expect((await stores.auditStore.listRecent(10)).map((r) => r.prompt)).toEqual(["second", "first"]);
    expect((await stores.auditStore.listByThread("C1", "1.0")).map((r) => r.prompt)).toEqual(["second", "first"]);
  });
});

// ---------------------------------------------------------------------------
// createStores factory
// ---------------------------------------------------------------------------

describe("createStores", () => {
  it("returns sqlite stores for :memory:", () => {
    const s = createStores(":memory:");
    expect(s.urlStore).toBeDefined();
    expect(s.configStore).toBeDefined();
    expect(s.auditStore).toBeDefined();
  });

  it("returns sqlite stores for file: prefix", () => {
    const s = createStores("file::memory:");
    expect(s.urlStore).toBeDefined();
  });

  it("returns different stores for postgres:// URL vs :memory:", () => {
    const sqlite = createStores(":memory:");
    const pg = createStores("postgres://localhost/test");
    // Different constructor names confirm different implementations
    expect(sqlite.urlStore.constructor.name).toBe("SqliteUrlStore");
    expect(pg.urlStore.constructor.name).toBe("PostgresUrlStore");
  });

  it("opens one shared postgres client for all three stores", () => {
    vi.mocked(postgres).mockClear();
    createStores("postgres://localhost/test");
    expect(postgres).toHaveBeenCalledTimes(1);
  });
});
