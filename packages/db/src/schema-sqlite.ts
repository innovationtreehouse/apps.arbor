import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const urlConfig = sqliteTable("url_config", {
  url: text("url").primaryKey(),
  description: text("description").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  added_by: text("added_by").notNull(),
  added_at: text("added_at").notNull().$default(() => new Date().toISOString()),
});

export const agentConfig = sqliteTable("agent_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  channel: text("channel").notNull(),
  thread_ts: text("thread_ts").notNull(),
  user_id: text("user_id").notNull(),
  prompt: text("prompt").notNull(),
  response: text("response").notNull(),
  model: text("model"),
  duration_ms: integer("duration_ms").notNull(),
  created_at: text("created_at").notNull().$default(() => new Date().toISOString()),
});

export const socialPosts = sqliteTable("social_posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  platform: text("platform").notNull(),
  content: text("content").notNull(),
  media_url: text("media_url"),
  scheduled_at: text("scheduled_at").notNull(),
  proposer_id: text("proposer_id").notNull(),
  slack_view_id: text("slack_view_id").unique(),
  status: text("status").notNull().default("pending_review"),
  review: text("review"),
  channel: text("channel"),
  thread_ts: text("thread_ts"),
  approved_by: text("approved_by"),
  objected_by: text("objected_by"),
  posted_by: text("posted_by"),
  posted_at: text("posted_at"),
  pull_reason: text("pull_reason"),
  pull_requested_by: text("pull_requested_by"),
  pulled_by: text("pulled_by"),
  pulled_at: text("pulled_at"),
  nudged_at: text("nudged_at"),
  created_at: text("created_at").notNull().$default(() => new Date().toISOString()),
  updated_at: text("updated_at").notNull().$default(() => new Date().toISOString()),
});
