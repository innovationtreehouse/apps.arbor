export type SocialPlatform = "instagram" | "facebook" | "x";

export type SocialPostStatus =
  | "pending_review"  // proposed, agent review not yet posted
  | "in_review"       // review posted, awaiting approver decision
  | "approved"        // >=1 approval, no open objection; ready to post
  | "objected"        // an open objection
  | "posted"          // an approver marked it posted
  | "pull_requested"  // someone asked for the live post to be taken down
  | "pulled"          // an approver confirmed it is down (v1: not restorable)
  | "withdrawn";      // proposer withdrew, or the proposal failed to post

export interface SocialPost {
  id: number;
  platform: SocialPlatform;
  content: string;
  media_url: string | null;      // Google Drive link; required for instagram
  scheduled_at: string;          // ISO 8601
  proposer_id: string;           // Slack user ID
  slack_view_id: string | null;  // modal view id; UNIQUE, makes proposals idempotent
  status: SocialPostStatus;
  review: string | null;         // agent review text (markdown)
  channel: string | null;        // approvals channel
  thread_ts: string | null;      // root message ts in approvals channel
  approved_by: string | null;    // Slack user ID
  objected_by: string | null;    // Slack user ID with open objection
  posted_by: string | null;
  posted_at: string | null;
  pull_reason: string | null;
  pull_requested_by: string | null;
  pulled_by: string | null;
  pulled_at: string | null;
  nudged_at: string | null;      // when the missed-time nudge was sent
  created_at: string;
  updated_at: string;            // bumped on every update; doubles as the optimistic-concurrency version
}

export type NewSocialPost = Pick<
  SocialPost,
  "platform" | "content" | "media_url" | "scheduled_at" | "proposer_id" | "slack_view_id"
>;

export type SocialPostPatch = Partial<
  Omit<SocialPost, "id" | "created_at" | "updated_at" | "slack_view_id">
>;

export interface SocialPostStore {
  /** Inserts; if slack_view_id already exists, returns the existing row unchanged. */
  create(post: NewSocialPost): Promise<SocialPost>;
  get(id: number): Promise<SocialPost | undefined>;
  /**
   * Partial update; bumps updated_at. With `expectUpdatedAt`, only applies when the
   * row's updated_at still equals it, else returns undefined (someone else changed it).
   */
  update(id: number, patch: SocialPostPatch, expectUpdatedAt?: string): Promise<SocialPost | undefined>;
  /** Posts not in a terminal state (posted/pulled/withdrawn), newest first. */
  listOpen(): Promise<SocialPost[]>;
  /**
   * Posts on `platform` with status not pending_review/pulled/withdrawn, scheduled within
   * `windowMs` of `scheduledAt` — for the duplicate / conflict check.
   */
  listNear(platform: SocialPlatform, scheduledAt: string, windowMs: number): Promise<SocialPost[]>;
  /** Approved posts whose scheduled_at has passed and nudged_at is null. */
  listDueForNudge(now: string): Promise<SocialPost[]>;
}

// ---------------------------------------------------------------------------
// Slack ↔ SQS contracts shared by the Lambda (producer) and the agent (consumer)
// ---------------------------------------------------------------------------

/** Modal submitted via /propose-post. Lambda has NOT written to the DB. */
export interface SocialPostProposed {
  type: "social_post_proposed";
  view_id: string;      // payload.view.id — resubmits of the same modal carry the same id
  platform: SocialPlatform;
  content: string;
  media_url: string | null;
  scheduled_at: string; // ISO 8601
  proposer_id: string;
  response_url: string; // slash-command response_url, for ephemeral feedback
}

/** Modal submitted via the Edit button on an existing post. */
export interface SocialPostEdited {
  type: "social_post_edited";
  post_id: number;
  version: string;      // post.updated_at the modal was opened against
  platform: SocialPlatform;
  content: string;
  media_url: string | null;
  scheduled_at: string;
  user_id: string;
  response_url: string;
}

export const SOCIAL_ACTIONS = [
  "approve", "object", "clear_objection", "mark_posted", "withdraw", "request_pull", "mark_pulled",
] as const;
export type SocialPostActionName = (typeof SOCIAL_ACTIONS)[number];

/** A button click on the approval card (or the pull-reason modal submission). */
export interface SocialPostAction {
  type: "social_post_action";
  post_id: number;
  version: string;      // post.updated_at encoded in the button value; stale → refused
  action: SocialPostActionName;
  user_id: string;
  response_url: string;
  reason?: string;      // request_pull only; required by the modal
}

/** Fired by the EventBridge rule that invokes the Lambda directly. */
export interface SocialPostNudge {
  type: "social_post_nudge";
}

export type SocialPostMessage = SocialPostProposed | SocialPostEdited | SocialPostAction | SocialPostNudge;

export const SOCIAL_MODAL_CALLBACK_ID = "social_post_modal";
export const SOCIAL_PULL_MODAL_CALLBACK_ID = "social_pull_modal";
/** action_id = `${SOCIAL_ACTION_PREFIX}${action}`; value = `${post.id}:${post.updated_at}`. "edit" also uses this prefix but opens a modal in the Lambda. */
export const SOCIAL_ACTION_PREFIX = "social_post:";
