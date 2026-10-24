import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, count } from "drizzle-orm";
import { urlConfig } from "./schema.js";
import type { UrlStore, UrlEntry, NewUrlEntry } from "./store.js";

/** Accepts a URL or an existing client so createStores can share one pool. */
export function pgClient(conn: string | postgres.Sql): postgres.Sql {
  return typeof conn === "string" ? postgres(conn) : conn;
}

export class PostgresUrlStore implements UrlStore {
  private db: ReturnType<typeof drizzle>;

  constructor(conn: string | postgres.Sql) {
    this.db = drizzle(pgClient(conn), { schema: { urlConfig } });
  }

  async listEnabled(): Promise<UrlEntry[]> {
    const rows = await this.db
      .select()
      .from(urlConfig)
      .where(eq(urlConfig.enabled, true));
    return rows.map(toEntry);
  }

  async listAll(): Promise<UrlEntry[]> {
    const rows = await this.db.select().from(urlConfig);
    return rows.map(toEntry);
  }

  async upsert(entry: NewUrlEntry): Promise<void> {
    await this.db
      .insert(urlConfig)
      .values({
        url: entry.url,
        description: entry.description,
        enabled: entry.enabled,
        added_by: entry.added_by,
      })
      .onConflictDoUpdate({
        target: urlConfig.url,
        set: {
          description: entry.description,
          enabled: entry.enabled,
          added_by: entry.added_by,
        },
      });
  }

  async delete(url: string): Promise<void> {
    await this.db.delete(urlConfig).where(eq(urlConfig.url, url));
  }

  async count(): Promise<number> {
    const result = await this.db
      .select({ value: count() })
      .from(urlConfig);
    return Number(result[0]?.value ?? 0);
  }
}

function toEntry(row: typeof urlConfig.$inferSelect): UrlEntry {
  return {
    url: row.url,
    description: row.description,
    enabled: row.enabled,
    added_by: row.added_by,
    added_at: row.added_at.toISOString(),
  };
}
