CREATE TABLE IF NOT EXISTS "social_posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"content" text NOT NULL,
	"media_url" text,
	"scheduled_at" timestamp with time zone NOT NULL,
	"proposer_id" text NOT NULL,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"review" text,
	"channel" text,
	"thread_ts" text,
	"approved_by" text,
	"objected_by" text,
	"posted_by" text,
	"posted_at" timestamp with time zone,
	"nudged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
