import { describe, it, expect, vi } from "vitest";
import { createAuditLogger } from "../audit-store.js";
import type { AuditStore, NewAuditRecord } from "../store.js";

const record: NewAuditRecord = {
  channel: "C1",
  thread_ts: "1.0",
  user_id: "U1",
  prompt: "hello",
  response: "world",
  model: "claude-opus-4-6",
  duration_ms: 1000,
};

const makeStore = (overrides: Partial<AuditStore> = {}): AuditStore => ({
  write: vi.fn().mockResolvedValue(undefined),
  listRecent: vi.fn().mockResolvedValue([]),
  listByThread: vi.fn().mockResolvedValue([]),
  ...overrides,
});

describe("createAuditLogger", () => {
  it("calls store.write with the record", async () => {
    const store = makeStore();
    await createAuditLogger(store).log(record);
    expect(store.write).toHaveBeenCalledWith(record);
  });

  it("swallows errors from store.write", async () => {
    const store = makeStore({ write: vi.fn().mockRejectedValue(new Error("DB down")) });
    await expect(createAuditLogger(store).log(record)).resolves.toBeUndefined();
  });

  it("logs error to console when write fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = makeStore({ write: vi.fn().mockRejectedValue(new Error("timeout")) });
    await createAuditLogger(store).log(record);
    expect(spy).toHaveBeenCalledWith("[audit] write failed:", expect.any(Error));
    spy.mockRestore();
  });
});
