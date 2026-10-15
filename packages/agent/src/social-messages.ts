// SQS message shapes shared by the Lambda (producer) and the agent (consumer)
// for the social post approval flow. Lambda copies these types verbatim
// (it does not depend on @arbor/agent).

import type { SocialPlatform } from "@arbor/db";

/** Modal submitted via /propose-post. Lambda has NOT written to the DB. */
export interface SocialPostProposed {
  type: "social_post_proposed";
  platform: SocialPlatform;
  content: string;
  media_url: string | null;
  scheduled_at: string; // ISO 8601, from Slack datetimepicker (unix seconds * 1000)
  proposer_id: string;
  response_url: string; // for ephemeral feedback to the proposer
}

/** Modal submitted via the Edit button on an existing post. */
export interface SocialPostEdited {
  type: "social_post_edited";
  post_id: number;
  platform: SocialPlatform;
  content: string;
  media_url: string | null;
  scheduled_at: string;
  user_id: string;
}

export type SocialPostActionName = "approve" | "object" | "clear_objection" | "mark_posted" | "withdraw";

/** A block_actions button click on the approval thread root message. */
export interface SocialPostAction {
  type: "social_post_action";
  post_id: number;
  action: SocialPostActionName;
  user_id: string;
  response_url: string;
}

/** Fired by the EventBridge → Lambda /cron/social-nudge route. */
export interface SocialPostNudge {
  type: "social_post_nudge";
}

export type SocialPostMessage = SocialPostProposed | SocialPostEdited | SocialPostAction | SocialPostNudge;

/** Slack block action_ids and the modal callback_id, shared by both sides. */
export const SOCIAL_MODAL_CALLBACK_ID = "social_post_modal";
export const SOCIAL_ACTION_PREFIX = "social_post:"; // action_id = `${prefix}${action}`; value = String(post_id)
