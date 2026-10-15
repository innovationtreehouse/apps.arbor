ALTER TABLE "social_posts" ADD COLUMN "slack_view_id" text;--> statement-breakpoint
ALTER TABLE "social_posts" ADD COLUMN "pull_reason" text;--> statement-breakpoint
ALTER TABLE "social_posts" ADD COLUMN "pull_requested_by" text;--> statement-breakpoint
ALTER TABLE "social_posts" ADD COLUMN "pulled_by" text;--> statement-breakpoint
ALTER TABLE "social_posts" ADD COLUMN "pulled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_slack_view_id_unique" UNIQUE("slack_view_id");