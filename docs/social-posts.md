# Social Post Approval: Design Document

## 1. Purpose and Goals

Squirrel gives the team a Slack-native approval flow for social media posts. A proposer submits a draft with `/propose-post`; the agent reviews it against platform limits and the brand style guide; designated approvers approve or object in a Slack thread; once settled, the post is published by hand and marked posted.

Goals:

- One place to propose, review, and approve posts for Instagram, Facebook, and X
- An automated first-pass review so approvers see problems (limits, voice, risk, conflicts) before they read the draft
- An explicit approval record: who approved, who objected, who posted, and when
- A nudge when an approved post passes its scheduled time without being marked posted

## 2. Non-Goals for v1

- Publishing through platform APIs. Publishing is a manual copy/paste.
- Auto-posting at the scheduled time. `scheduled_at` drives the nudge, not a publisher.
- A web UI. Everything happens in Slack.
- Uploading media to Slack. Media is a Google Drive link.
- Multi-workspace deployments (same as the rest of Arbor).

## 3. User Flow

```
Proposer: /propose-post
   │  Lambda opens a modal (views.open): platform, scheduled time,
   │  content, optional media_url (required for Instagram)
   ▼
Modal submit ──► Lambda ──► SQS ──► agent creates the row, runs the review
   │
   ▼
Agent posts a root message in SOCIAL_APPROVALS_CHANNEL: the draft, the
review, and buttons. The root message ts is stored as thread_ts.
   │
   ▼
Approvers click Approve / Object (Clear objection later). Proposer may
Edit or Withdraw. One approval and no open objection settles the post.
   │
   ▼
Message updates to "approved": copy ready to paste + Mark posted button.
A human pastes it into the platform, then an approver clicks Mark posted.
   │
   ▼
If scheduled_at passes while still approved, the agent posts one thread
nudge tagging the approvers.
```

The agent's response to the proposer on invalid input (for example, Instagram without media) is ephemeral, sent to the modal's `response_url`.

## 4. State Machine

Statuses come from `SocialPostStatus` in `packages/db/src/social-store.ts`.

| From | To | Trigger | Who |
|---|---|---|---|
| (none) | `pending_review` | Row created from `social_post_proposed` | Agent |
| `pending_review` | `in_review` | Review posted in approvals channel | Agent |
| `in_review` | `approved` | Approve, with no open objection | Approver |
| `in_review` | `objected` | Object | Approver |
| `approved` | `objected` | Object | Approver |
| `objected` | `approved` or `in_review` | Clear objection (to `approved` if an approval exists, else `in_review`) | Approver |
| `approved` | `posted` | Mark posted (only valid from `approved`) | Approver |
| any non-terminal | `withdrawn` | Withdraw | Proposer |

`posted` and `withdrawn` are terminal. Edit is proposer-only and resubmits the draft through the modal (`social_post_edited`); the agent re-runs the review. Button clicks from users who lack the required role get an ephemeral refusal and change nothing. Approvers are the user IDs in `SOCIAL_APPROVER_IDS`.

## 5. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                       Slack Workspace                        │
│  /propose-post ─► modal ─► view_submission                   │
│  Buttons (approve, object, ...) ─► block_actions             │
└───────────────┬──────────────────────────────────────────────┘
                │ HTTPS POST                    ┌──────────────────┐
                ▼                               │ EventBridge      │
   ┌───────────────────────────┐   x-cron-      │ Scheduler        │
   │ AWS Lambda (API Gateway)  │◄──secret ──────│ every 15 min     │
   │ POST /slack/commands      │                └──────────────────┘
   │ POST /slack/interactions  │
   │ POST /cron/social-nudge   │
   │                           │
   │ - verify signature / secret
   │ - views.open (SLACK_BOT_TOKEN, trigger_id valid 3s)
   │ - ACK, ensure ECS task running
   │ - enqueue social_* message
   └─────────────┬─────────────┘
                 │ SQS
                 ▼
   ┌───────────────────────────┐        ┌─────────────────────────┐
   │ ECS agent                 │───────►│ PostgreSQL              │
   │ - dispatch on parsed.type │        │ social_posts            │
   │ - create row, run review  │        └─────────────────────────┘
   │ - post / update messages  │
   │ - nudge approvers         │───────► Google Drive (style guide)
   └───────────────────────────┘
```

The Lambda never writes `social_posts`; it only opens the modal and enqueues. All state changes happen in the agent, which serializes them through one SQS consumer.

## 6. Agentic Review

When a post is created or edited, the agent runs a review and posts it with the draft. The review checks:

- **Platform limits.** A deterministic check (`checkPlatformLimits`) for character count, hashtag count, and required media. Violations are listed verbatim and are not left to the model.
- **Brand voice.** Compared against the style guide document in Google Drive, read with the existing Drive MCP server.
- **Risk flags.** Claims, legal or sensitive topics, personal information, anything likely to need a second look.
- **Duplicates and conflicts.** Posts on the same platform scheduled near this one (`listNear`) that repeat or collide with it.

The review ends with a single line:

```
VERDICT: OK | REVISE | BLOCK
```

- `OK`: no issues found.
- `REVISE`: fixable issues; the proposer should edit.
- `BLOCK`: a hard problem (limit violation, missing required media, serious risk).

The verdict is advice. It does not change status; approvers decide.

## 7. Data Model

Table `social_posts` (Postgres, Drizzle; SQLite twin for tests). Migration `0001_social_posts.sql`.

| Column | Type | Description |
|---|---|---|
| `id` (PK) | serial | Post ID; carried in button values |
| `platform` | text | `instagram`, `facebook`, or `x` |
| `content` | text | Draft text |
| `media_url` | text, null | Google Drive link; required for Instagram |
| `scheduled_at` | timestamptz | Intended publish time |
| `proposer_id` | text | Slack user ID |
| `status` | text | See §4 |
| `review` | text, null | Agent review (markdown), including the `VERDICT:` line |
| `channel` | text, null | Approvals channel ID |
| `thread_ts` | text, null | Root message ts in the approvals channel |
| `approved_by` | text, null | Slack user ID |
| `objected_by` | text, null | Slack user ID holding the open objection |
| `posted_by` | text, null | Slack user ID |
| `posted_at` | timestamptz, null | When marked posted |
| `nudged_at` | timestamptz, null | When the missed-time nudge was sent |
| `created_at` | timestamptz | Row creation |
| `updated_at` | timestamptz | Bumped on every update |

## 8. SQS Message Types

Defined in `packages/agent/src/social-messages.ts`; the Lambda copies the types and does not depend on `@arbor/agent`.

| `type` | Producer | Payload |
|---|---|---|
| `social_post_proposed` | Modal submit | `platform`, `content`, `media_url`, `scheduled_at`, `proposer_id`, `response_url` |
| `social_post_edited` | Edit-modal submit | `post_id`, `platform`, `content`, `media_url`, `scheduled_at`, `user_id` |
| `social_post_action` | Button click | `post_id`, `action` (`approve`, `object`, `clear_objection`, `mark_posted`, `withdraw`), `user_id`, `response_url` |
| `social_post_nudge` | `/cron/social-nudge` | none |

Modal `callback_id` is `social_post_modal`. Button `action_id` is `social_post:<action>` with the post ID as the value.

The nudge handler selects approved posts with `scheduled_at` past and `nudged_at` null (`listDueForNudge`), posts one thread reply tagging `SOCIAL_APPROVER_IDS`, and sets `nudged_at`. A post is nudged at most once.

## 9. Configuration

| Variable | Component | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | Lambda (new) | Needed for `views.open`; the `trigger_id` expires in 3 seconds, so the Lambda opens the modal itself |
| `CRON_SECRET` | Lambda | Shared secret; `/cron/social-nudge` rejects requests whose `x-cron-secret` header differs |
| `SOCIAL_APPROVALS_CHANNEL` | Agent | Channel ID where posts are reviewed and approved |
| `SOCIAL_APPROVER_IDS` | Agent | Comma-separated Slack user IDs allowed to approve, object, and mark posted |

`DATABASE_URL` is already set on both components. See [Runtime Configuration](configuration.md).

## 10. Slack App Changes

- **Slash command** `/propose-post`, Request URL `<API_URL>/slack/commands`.
- **Interactivity & Shortcuts**: enable, Request URL `<API_URL>/slack/interactions`. Receives modal submissions and button clicks.
- **Bot token scopes**: `chat:write` and `commands`. `views.open` needs no extra scope.
- Invite the bot to the approvals channel.

## 11. Open Questions

- Who are the approvers (initial `SOCIAL_APPROVER_IDS`)?
- Which Drive document is the style guide? The agent needs a fixed name or ID.
- After a withdraw, can the post be revived, or must the proposer re-propose? v1 treats `withdrawn` as terminal (re-propose).

## 12. Future Work

| Item | Trigger |
|---|---|
| Platform API adapters (publish on approval) | Meta app review is complete and/or an X paid API tier is purchased |
| Auto-post at `scheduled_at` | The manual paste/click proves to be the bottleneck (frequent nudges) |
| Slack file upload for media | Approvers or the Drive-link check reject links often enough to be a problem |
| Web UI | Proposers appear who are not in Slack |
