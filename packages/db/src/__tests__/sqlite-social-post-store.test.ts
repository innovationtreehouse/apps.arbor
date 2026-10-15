import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStores } from "../sqlite-stores.js";
import type { SqliteSocialPostStore } from "../sqlite-stores.js";

const T = "2026-11-01T15:00:00.000Z";
const HOUR = 3_600_000;
const at = (offsetMs: number) => new Date(Date.parse(T) + offsetMs).toISOString();

let dir: string;
let store: SqliteSocialPostStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "social-"));
  store = createSqliteStores(join(dir, "db.sqlite")).socialPostStore;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const make = (scheduled_at: string, platform: "x" | "instagram" = "x") =>
  store.create({ platform, content: "hi", media_url: null, scheduled_at, proposer_id: "U1" });

describe("SqliteSocialPostStore", () => {
  it("create + get round-trips with defaults", async () => {
    const p = await make("2026-11-01T10:00:00-05:00");
    expect(p).toMatchObject({ status: "pending_review", scheduled_at: T, review: null, nudged_at: null });
    expect(await store.get(p.id)).toEqual(p);
    expect(await store.get(999)).toBeUndefined();
  });

  it("update patches fields, bumps updated_at, throws on missing id", async () => {
    const p = await make(T);
    await new Promise((r) => setTimeout(r, 5));
    const u = await store.update(p.id, { status: "approved", approved_by: "U2" });
    expect(u).toMatchObject({ status: "approved", approved_by: "U2", content: "hi" });
    expect(u.updated_at > p.updated_at).toBe(true);
    await expect(store.update(999, { status: "posted" })).rejects.toThrow();
  });

  it("listOpen excludes posted/withdrawn, newest first", async () => {
    const a = await make(T);
    const b = await make(T);
    const c = await make(T);
    await store.update(c.id, { status: "withdrawn" });
    expect((await store.listOpen()).map((p) => p.id)).toEqual([b.id, a.id]);
  });

  it("listNear includes window edges, excludes outside, other platform, terminal", async () => {
    const edgeLo = await make(at(-HOUR));
    const edgeHi = await make(at(HOUR));
    await make(at(HOUR + 1));
    await make(at(-HOUR - 1));
    await make(T, "instagram");
    const posted = await make(T);
    await store.update(posted.id, { status: "posted" });
    const ids = (await store.listNear("x", T, HOUR)).map((p) => p.id).sort();
    expect(ids).toEqual([edgeLo.id, edgeHi.id]);
  });

  it("listDueForNudge = approved, past due, not yet nudged", async () => {
    const due = await make(at(-1));
    const future = await make(at(1));
    const nudged = await make(at(-1));
    const pending = await make(at(-1));
    for (const p of [due, future, nudged]) await store.update(p.id, { status: "approved" });
    await store.update(nudged.id, { nudged_at: T });
    expect((await store.listDueForNudge(T)).map((p) => p.id)).toEqual([due.id]);
    expect(pending.status).toBe("pending_review");
  });
});
