import { pgTable, text, boolean, timestamp, serial, integer } from "drizzle-orm/pg-core";

export const urlConfig = pgTable("url_config", {
  url: text("url").primaryKey(),
  description: text("description").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  added_by: text("added_by").notNull(),
  added_at: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentConfig = pgTable("agent_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  channel: text("channel").notNull(),
  thread_ts: text("thread_ts").notNull(),
  user_id: text("user_id").notNull(),
  prompt: text("prompt").notNull(),
  response: text("response").notNull(),
  model: text("model"),
  duration_ms: integer("duration_ms").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const socialPosts = pgTable("social_posts", {
  id: serial("id").primaryKey(),
  platform: text("platform").notNull(),
  content: text("content").notNull(),
  media_url: text("media_url"),
  scheduled_at: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  proposer_id: text("proposer_id").notNull(),
  slack_view_id: text("slack_view_id").unique(),
  status: text("status").notNull().default("pending_review"),
  review: text("review"),
  channel: text("channel"),
  thread_ts: text("thread_ts"),
  approved_by: text("approved_by"),
  objected_by: text("objected_by"),
  posted_by: text("posted_by"),
  posted_at: timestamp("posted_at", { withTimezone: true }),
  pull_reason: text("pull_reason"),
  pull_requested_by: text("pull_requested_by"),
  pulled_by: text("pulled_by"),
  pulled_at: timestamp("pulled_at", { withTimezone: true }),
  nudged_at: timestamp("nudged_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
