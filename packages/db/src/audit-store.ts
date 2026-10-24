import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import { desc, eq, and } from "drizzle-orm";
import { auditLog } from "./schema.js";
import { pgClient } from "./postgres-store.js";
import type { AuditStore, AuditRecord, NewAuditRecord } from "./store.js";

/* v8 ignore start */
export class PostgresAuditStore implements AuditStore {
  private db: ReturnType<typeof drizzle>;

  constructor(conn: string | postgres.Sql) {
    this.db = drizzle(pgClient(conn), { schema: { auditLog } });
  }

  async write(record: NewAuditRecord): Promise<void> {
    await this.db.insert(auditLog).values({
      channel: record.channel,
      thread_ts: record.thread_ts,
      user_id: record.user_id,
      prompt: record.prompt,
      response: record.response,
      model: record.model ?? null,
      duration_ms: record.duration_ms,
    });
  }

  async listRecent(limit: number): Promise<AuditRecord[]> {
    const rows = await this.db
      .select()
      .from(auditLog)
      .orderBy(desc(auditLog.created_at), desc(auditLog.id))
      .limit(limit);
    return rows.map(toRecord);
  }

  async listByThread(channel: string, thread_ts: string): Promise<AuditRecord[]> {
    const rows = await this.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.channel, channel), eq(auditLog.thread_ts, thread_ts)))
      .orderBy(desc(auditLog.created_at), desc(auditLog.id));
    return rows.map(toRecord);
  }
}

function toRecord(row: typeof auditLog.$inferSelect): AuditRecord {
  return {
    id: row.id,
    channel: row.channel,
    thread_ts: row.thread_ts,
    user_id: row.user_id,
    prompt: row.prompt,
    response: row.response,
    model: row.model,
    duration_ms: row.duration_ms,
    created_at: row.created_at.toISOString(),
  };
}
/* v8 ignore stop */
