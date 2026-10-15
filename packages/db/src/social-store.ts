export type SocialPlatform = "instagram" | "facebook" | "x";

export type SocialPostStatus =
  | "pending_review" // proposed, agent review not yet posted
  | "in_review"      // review posted, awaiting approver decision
  | "approved"       // >=1 approval, no open objection; ready to post
  | "objected"       // at least one open objection
  | "posted"         // an approver marked it posted
  | "withdrawn";     // proposer withdrew

export interface SocialPost {
  id: number;
  platform: SocialPlatform;
  content: string;
  media_url: string | null;      // Google Drive link; required for instagram
  scheduled_at: string;          // ISO 8601
  proposer_id: string;           // Slack user ID
  status: SocialPostStatus;
  review: string | null;         // agent review text (markdown)
  channel: string | null;        // approvals channel
  thread_ts: string | null;      // root message ts in approvals channel
  approved_by: string | null;    // Slack user ID
  objected_by: string | null;    // Slack user ID with open objection
  posted_by: string | null;
  posted_at: string | null;
  nudged_at: string | null;      // when the missed-time nudge was sent
  created_at: string;
  updated_at: string;
}

export type NewSocialPost = Pick<
  SocialPost,
  "platform" | "content" | "media_url" | "scheduled_at" | "proposer_id"
>;

export type SocialPostPatch = Partial<
  Omit<SocialPost, "id" | "created_at" | "updated_at">
>;

export interface SocialPostStore {
  create(post: NewSocialPost): Promise<SocialPost>;
  get(id: number): Promise<SocialPost | undefined>;
  /** Partial update; bumps updated_at. Returns the updated row. */
  update(id: number, patch: SocialPostPatch): Promise<SocialPost>;
  /** Posts not in a terminal state (posted/withdrawn), newest first. */
  listOpen(): Promise<SocialPost[]>;
  /**
   * Posts on `platform` with status not posted/withdrawn, scheduled within
   * `windowMs` of `scheduledAt` — for the duplicate / conflict check.
   */
  listNear(platform: SocialPlatform, scheduledAt: string, windowMs: number): Promise<SocialPost[]>;
  /** Approved posts whose scheduled_at has passed and nudged_at is null. */
  listDueForNudge(now: string): Promise<SocialPost[]>;
}
