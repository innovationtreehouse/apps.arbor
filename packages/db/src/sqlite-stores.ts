import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq, and, desc, count } from "drizzle-orm";
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
      .orderBy(desc(schema.auditLog.created_at), desc(schema.auditLog.id))
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
      .orderBy(desc(schema.auditLog.created_at), desc(schema.auditLog.id))
      .all();
    return rows.map(toAuditRecord);
  }
}

export function createSqliteStores(filePath: string): {
  urlStore: SqliteUrlStore;
  configStore: SqliteConfigStore;
  auditStore: SqliteAuditStore;
} {
  const db = openDb(filePath);
  return {
    urlStore: new SqliteUrlStore(db),
    configStore: new SqliteConfigStore(db),
    auditStore: new SqliteAuditStore(db),
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
