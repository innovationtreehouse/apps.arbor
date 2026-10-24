import { describe, expect, it, vi } from "vitest";
import { recordAndCheck, RATE_THRESHOLD, RATE_WINDOW_MS } from "../rate-limiter.js";
import type { ConfigStore } from "@arbor/db";

function makeStore(initial: Record<string, string> = {}): ConfigStore {
  const data = { ...initial };
  return {
    get: vi.fn(async (key: string) => data[key]),
    set: vi.fn(async (key: string, value: string) => { data[key] = value; }),
  };
}

const CH = "C_TEST";

describe("recordAndCheck", () => {
  it("returns false for the first mention", async () => {
    expect(await recordAndCheck(makeStore(), CH)).toBe(false);
  });

  it("returns false for the second mention", async () => {
    const store = makeStore();
    await recordAndCheck(store, CH, 1000);
    expect(await recordAndCheck(store, CH, 2000)).toBe(false);
  });

  it(`returns true on the ${RATE_THRESHOLD}th mention within the window`, async () => {
    const store = makeStore();
    const now = 10_000;
    await recordAndCheck(store, CH, now);
    await recordAndCheck(store, CH, now + 1000);
    expect(await recordAndCheck(store, CH, now + 2000)).toBe(true);
  });

  it("returns true for every mention beyond the threshold", async () => {
    const store = makeStore();
    const now = 10_000;
    for (let i = 0; i < RATE_THRESHOLD; i++) {
      await recordAndCheck(store, CH, now + i * 100);
    }
    expect(await recordAndCheck(store, CH, now + 5000)).toBe(true);
    expect(await recordAndCheck(store, CH, now + 6000)).toBe(true);
  });

  it("resets holdoff once old timestamps slide outside the window", async () => {
    const store = makeStore();
    const now = 10_000;
    // Three rapid mentions → holdoff
    for (let i = 0; i < RATE_THRESHOLD; i++) {
      await recordAndCheck(store, CH, now + i * 100);
    }
    // Well past the window — those timestamps should be pruned
    expect(await recordAndCheck(store, CH, now + RATE_WINDOW_MS + 10_000)).toBe(false);
  });

  it("prunes timestamps older than the window on each call", async () => {
    const store = makeStore();
    const now = 50_000;
    // Two old mentions
    await recordAndCheck(store, CH, now - RATE_WINDOW_MS - 5000);
    await recordAndCheck(store, CH, now - RATE_WINDOW_MS - 1000);
    // One recent mention — still only 1 in window, not in holdoff
    expect(await recordAndCheck(store, CH, now)).toBe(false);
  });

  it("tracks channels independently", async () => {
    const store = makeStore();
    const now = 10_000;
    // Flood channel A
    for (let i = 0; i < RATE_THRESHOLD; i++) {
      await recordAndCheck(store, "C_A", now + i * 100);
    }
    // Channel B should still be below threshold
    expect(await recordAndCheck(store, "C_B", now + 5000)).toBe(false);
  });

});
