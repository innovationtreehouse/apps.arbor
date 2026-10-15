import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq, and, desc, count, between, isNull, lte, notInArray } from "drizzle-orm";
import * as schema from "./schema-sqlite.js";
import type {
  UrlStore,
  UrlEntry,
  NewUrlEntry,
  ConfigStore,
  AuditStore,
  AuditRecord,
  NewAuditRecord,
} from "./store.js";
import type {
  SocialPlatform,
  SocialPost,
  SocialPostStatus,
  NewSocialPost,
  SocialPostPatch,
  SocialPostStore,
} from "./social-store.js";

type SqliteDb = ReturnType<typeof drizzle<typeof schema>>;

function openDb(filePath: string): SqliteDb {
  const sqlite = new Database(filePath);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS "url_config" (
      "url" text PRIMARY KEY NOT NULL,
      "description" text NOT NULL,
      "enabled" integer NOT NULL DEFAULT 1,
      "added_by" text NOT NULL,
      "added_at" text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS "agent_config" (
      "key" text PRIMARY KEY NOT NULL,
      "value" text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "audit_log" (
      "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      "channel" text NOT NULL,
      "thread_ts" text NOT NULL,
      "user_id" text NOT NULL,
      "prompt" text NOT NULL,
      "response" text NOT NULL,
      "model" text,
      "duration_ms" integer NOT NULL,
      "created_at" text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS "social_posts" (
      "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      "platform" text NOT NULL,
      "content" text NOT NULL,
      "media_url" text,
      "scheduled_at" text NOT NULL,
      "proposer_id" text NOT NULL,
      "status" text NOT NULL DEFAULT 'pending_review',
      "review" text,
      "channel" text,
      "thread_ts" text,
      "approved_by" text,
      "objected_by" text,
      "posted_by" text,
      "posted_at" text,
      "nudged_at" text,
      "created_at" text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      "updated_at" text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  return drizzle(sqlite, { schema });
}

export class SqliteUrlStore implements UrlStore {
  constructor(private db: SqliteDb) {}

  async listEnabled(): Promise<UrlEntry[]> {
    const rows = this.db
      .select()
      .from(schema.urlConfig)
      .where(eq(schema.urlConfig.enabled, true))
      .all();
    return rows.map(toUrlEntry);
  }

  async listAll(): Promise<UrlEntry[]> {
    return this.db.select().from(schema.urlConfig).all().map(toUrlEntry);
  }

  async upsert(entry: NewUrlEntry): Promise<void> {
    this.db
      .insert(schema.urlConfig)
      .values({
        url: entry.url,
        description: entry.description,
        enabled: entry.enabled,
        added_by: entry.added_by,
      })
      .onConflictDoUpdate({
        target: schema.urlConfig.url,
        set: {
          description: entry.description,
          enabled: entry.enabled,
          added_by: entry.added_by,
        },
      })
      .run();
  }

  async delete(url: string): Promise<void> {
    this.db.delete(schema.urlConfig).where(eq(schema.urlConfig.url, url)).run();
  }

  async count(): Promise<number> {
    const result = this.db
      .select({ value: count() })
      .from(schema.urlConfig)
      .get();
    return Number(result?.value ?? 0);
  }
}

export class SqliteConfigStore implements ConfigStore {
  constructor(private db: SqliteDb) {}

  async get(key: string): Promise<string | undefined> {
    const row = this.db
      .select()
      .from(schema.agentConfig)
      .where(eq(schema.agentConfig.key, key))
      .get();
    return row?.value;
  }

  async set(key: string, value: string): Promise<void> {
    this.db
      .insert(schema.agentConfig)
      .values({ key, value })
      .onConflictDoUpdate({ target: schema.agentConfig.key, set: { value } })
      .run();
  }
}

export class SqliteAuditStore implements AuditStore {
  constructor(private db: SqliteDb) {}

  async write(record: NewAuditRecord): Promise<void> {
    this.db
      .insert(schema.auditLog)
      .values({
        channel: record.channel,
        thread_ts: record.thread_ts,
        user_id: record.user_id,
        prompt: record.prompt,
        response: record.response,
        model: record.model ?? null,
        duration_ms: record.duration_ms,
      })
      .run();
  }

  async listRecent(limit: number): Promise<AuditRecord[]> {
    const rows = this.db
      .select()
      .from(schema.auditLog)
      .orderBy(desc(schema.auditLog.created_at))
      .limit(limit)
      .all();
    return rows.map(toAuditRecord);
  }

  async listByThread(channel: string, thread_ts: string): Promise<AuditRecord[]> {
    const rows = this.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.channel, channel),
          eq(schema.auditLog.thread_ts, thread_ts)
        )
      )
      .orderBy(desc(schema.auditLog.created_at))
      .all();
    return rows.map(toAuditRecord);
  }
}

// Timestamps are normalized to toISOString() so text comparison == time order.
const iso = (s: string) => new Date(s).toISOString();
const isoOrNull = (s: string | null | undefined) => (s == null ? s : iso(s));
const TERMINAL: SocialPostStatus[] = ["posted", "withdrawn"];

export class SqliteSocialPostStore implements SocialPostStore {
  constructor(private db: SqliteDb) {}

  async create(post: NewSocialPost): Promise<SocialPost> {
    const row = this.db
      .insert(schema.socialPosts)
      .values({ ...post, scheduled_at: iso(post.scheduled_at) })
      .returning()
      .get();
    return toSocialPost(row);
  }

  async get(id: number): Promise<SocialPost | undefined> {
    const row = this.db.select().from(schema.socialPosts).where(eq(schema.socialPosts.id, id)).get();
    return row && toSocialPost(row);
  }

  async update(id: number, patch: SocialPostPatch): Promise<SocialPost> {
    const row = this.db
      .update(schema.socialPosts)
      .set({
        ...patch,
        scheduled_at: patch.scheduled_at ? iso(patch.scheduled_at) : undefined,
        posted_at: isoOrNull(patch.posted_at),
        nudged_at: isoOrNull(patch.nudged_at),
        updated_at: new Date().toISOString(),
      })
      .where(eq(schema.socialPosts.id, id))
      .returning()
      .get();
    if (!row) throw new Error(`social post ${id} not found`);
    return toSocialPost(row);
  }

  async listOpen(): Promise<SocialPost[]> {
    return this.db
      .select()
      .from(schema.socialPosts)
      .where(notInArray(schema.socialPosts.status, TERMINAL))
      .orderBy(desc(schema.socialPosts.created_at), desc(schema.socialPosts.id))
      .all()
      .map(toSocialPost);
  }

  async listNear(platform: SocialPlatform, scheduledAt: string, windowMs: number): Promise<SocialPost[]> {
    const t = new Date(scheduledAt).getTime();
    return this.db
      .select()
      .from(schema.socialPosts)
      .where(
        and(
          eq(schema.socialPosts.platform, platform),
          notInArray(schema.socialPosts.status, TERMINAL),
          between(
            schema.socialPosts.scheduled_at,
            new Date(t - windowMs).toISOString(),
            new Date(t + windowMs).toISOString()
          )
        )
      )
      .all()
      .map(toSocialPost);
  }

  async listDueForNudge(now: string): Promise<SocialPost[]> {
    return this.db
      .select()
      .from(schema.socialPosts)
      .where(
        and(
          eq(schema.socialPosts.status, "approved"),
          lte(schema.socialPosts.scheduled_at, iso(now)),
          isNull(schema.socialPosts.nudged_at)
        )
      )
      .all()
      .map(toSocialPost);
  }
}

export function createSqliteStores(filePath: string): {
  urlStore: SqliteUrlStore;
  configStore: SqliteConfigStore;
  auditStore: SqliteAuditStore;
  socialPostStore: SqliteSocialPostStore;
} {
  const db = openDb(filePath);
  return {
    urlStore: new SqliteUrlStore(db),
    configStore: new SqliteConfigStore(db),
    auditStore: new SqliteAuditStore(db),
    socialPostStore: new SqliteSocialPostStore(db),
  };
}

function toUrlEntry(row: typeof schema.urlConfig.$inferSelect): UrlEntry {
  return {
    url: row.url,
    description: row.description,
    enabled: row.enabled,
    added_by: row.added_by,
    added_at: row.added_at,
  };
}

function toAuditRecord(row: typeof schema.auditLog.$inferSelect): AuditRecord {
  return {
    id: row.id,
    channel: row.channel,
    thread_ts: row.thread_ts,
    user_id: row.user_id,
    prompt: row.prompt,
    response: row.response,
    model: row.model,
    duration_ms: row.duration_ms,
    created_at: row.created_at,
  };
}

function toSocialPost(row: typeof schema.socialPosts.$inferSelect): SocialPost {
  return { ...row, platform: row.platform as SocialPlatform, status: row.status as SocialPostStatus };
}
