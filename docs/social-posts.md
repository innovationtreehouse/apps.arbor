# Social Post Approval: Design Document

## 1. Purpose and Goals

Squirrel gives the team a Slack-native approval flow for social media posts. A proposer submits a draft with `/propose-post`; the agent reviews it against platform limits and the brand style guide; designated approvers approve or object in a Slack thread; once settled, the post is published by hand and marked posted. A posted draft can later be pulled (Request pull / Mark pulled).

Goals:

- One place to propose, review, and approve posts for Instagram, Facebook, and X
- An automated first-pass review so approvers see problems (limits, voice, risk, conflicts) before they read the draft
- An explicit approval record: who approved, who objected, who posted, and when
- A nudge when an approved post passes its scheduled time without being marked posted
- A fast path to pull a post that has already gone out

## 2. Non-Goals for v1

- Publishing through platform APIs. Publishing is a manual copy/paste.
- Auto-posting at the scheduled time. `scheduled_at` drives the nudge, not a publisher.
- A web UI. Everything happens in Slack.
- Uploading media to Slack. Media is a Google Drive link.
- Multi-workspace deployments (same as the rest of Arbor).

## 3. User Flow

```
Proposer: /propose-post
   │  Lambda opens a modal (views.open): platform (one per proposal),
   │  scheduled time, content, optional media_url (required for Instagram)
   ▼
Modal submit ──► Lambda validates (inline modal errors) ──► SQS
   │                                   ──► agent creates the row, runs the review
   ▼
Agent posts a root message in SOCIAL_APPROVALS_CHANNEL: the draft, the
review (verdict in the header), and buttons. Root ts is stored as thread_ts.
   │
   ▼
Approvers click Approve / Object / Clear objection. Proposer may Edit or
Withdraw. One approval (not by the proposer) and no open objection settles it.
   │
   ▼
"approved": copy ready to paste + Mark posted button. A human pastes it
into the platform, then an approver clicks Mark posted.
   │
   ▼
If scheduled_at passes while still approved, the agent posts one thread
nudge tagging the approvers. A posted card has Request pull for approvers
and the proposer; the agent immediately tags all approvers in the thread.
```

Invalid input is reported inline in the modal (the Lambda validates before enqueueing). Other refusals (wrong role, stale card) are ephemeral.

## 4. State Machine

Statuses come from `SocialPostStatus` in `packages/db/src/social-store.ts`.

| From | To | Action | Who |
|---|---|---|---|
| (none) | `pending_review` | Row created from `social_post_proposed` | Agent |
| `pending_review` | `in_review` | Review posted in approvals channel | Agent |
| `in_review` | `approved` | `approve`, with no open objection | Approver other than the proposer (self-approve is refused, even for approvers) |
| `in_review`, `approved` | `objected` | `object` | Approver |
| `objected` | `approved` or `in_review` | `clear_objection` (`approved` if an approval exists) | Any approver, whoever objected |
| `approved` | `posted` | `mark_posted` | Approver |
| any non-terminal except `posted` | `withdrawn` | `withdraw` | Proposer or any approver (so orphans can be closed) |
| `posted` | `pull_requested` | `request_pull` with a required reason | Approver or proposer |
| `pull_requested` | `pulled` | `mark_pulled` | Approver |

`withdrawn` and `pulled` are terminal in v1 (a restore is left for later); `posted` is terminal except for the pull path. Withdraw is not offered from `posted`; use Request pull. Approvers are the user IDs in `SOCIAL_APPROVER_IDS`. Wrong-role clicks get an ephemeral refusal and change nothing.

**Edit** (proposer only, from `in_review`/`objected`/`approved`) resubmits through the modal (`social_post_edited`). It keeps `objected_by`, clears `approved_by`, sets status to `objected` if an objection is open else `in_review`, and re-runs the review. The modal carries the version it was opened against; a stale submit is refused.

**Request pull** opens a modal with a required reason; the agent stores `pull_reason`/`pull_requested_by` and posts in the thread at once, tagging every approver (not via the nudge).

**Concurrency.** Two agent tasks can run at once (see [Operation](operation.md#concurrency)). Every transition is an optimistic conditional update on `updated_at`. Button values are `<post_id>:<updated_at>` and edit/pull messages carry the same `version`; a stale click is refused with an ephemeral "This post changed since you loaded it, re-check the card." A conditional update that matches no row is treated the same way. Proposals are idempotent on the Slack view id (`slack_view_id`, unique): a redelivered submission with an existing `thread_ts` does nothing.

**Audit.** Every transition writes `audit_log` (prompt `social_post:<action> #<id>`, response `<old> → <new>`), viewable with `/squirrel-admin audit-thread`. `/squirrel-admin social-posts` lists open posts.

**Failure handling.**
- Misconfiguration (`SOCIAL_APPROVALS_CHANNEL` unset or no approvers) is refused with a clear message before the row is inserted.
- If anything fails after insert, the row is set to `withdrawn`, the proposer gets an ephemeral error, and the error is rethrown (no orphaned `pending_review` rows).
- The nudge isolates each post (one failure does not block others) and is at-most-once: `nudged_at` is set with a conditional update first, and the message is posted only if that update succeeded.

User-supplied text (content, media label, review) is escaped for mrkdwn (`&`, `<`, `>`), and ``` inside the copy-paste block is neutralised.

## 5. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                       Slack Workspace                        │
│  /propose-post ─► modal ─► view_submission                   │
│  Buttons (approve, object, ...) ─► block_actions             │
└───────────────┬──────────────────────────────────────────────┘
                │ HTTPS POST                    ┌──────────────────┐
                ▼                               │ EventBridge rule │
   ┌───────────────────────────┐   direct       │ rate(15 minutes) │
   │ AWS Lambda (API Gateway)  │◄──invoke (IAM)─│                  │
   │ POST /slack/commands      │                └──────────────────┘
   │ POST /slack/interactions  │
   │                           │
   │ - verify signature
   │ - views.open (SLACK_BOT_TOKEN, trigger_id valid 3s)
   │ - validate modal input (inline errors)
   │ - read social_posts: Edit / Request-pull modals, nudge check
   │ - ACK, ensure ECS task running
   │ - enqueue social_* message
   └─────────────┬─────────────┘
                 │ SQS
                 ▼
   ┌───────────────────────────┐        ┌─────────────────────────┐
   │ ECS agent (1..2 tasks)    │───────►│ PostgreSQL              │
   │ - dispatch on parsed.type │        │ social_posts, audit_log │
   │ - create row, run review  │        └─────────────────────────┘
   │ - post / update messages  │
   │ - nudge approvers         │───────► Google Drive (style guide)
   └───────────────────────────┘
```

The Lambda only reads `social_posts` (to open the Edit and Request-pull modals and to check for due nudges); all writes happen in the agent. The agent is not a single consumer: correctness comes from the conditional updates in §4.

**Nudge.** An EventBridge rule invokes the Lambda directly (`event.source === "aws.events"`) every 15 minutes. The Lambda calls `listDueForNudge` against Postgres and enqueues `social_post_nudge` only if some posts are due, so an idle system never wakes the agent. There is no HTTP cron route and no shared secret.

## 6. Agentic Review

When a post is created or edited, the agent runs a review and posts it with the draft. The review checks:

- **Platform limits.** Deterministic (`checkPlatformLimits`), not left to the model: X length (approximate weighted count), Instagram hashtag cap, required media. X has no hashtag cap. Violations are listed verbatim.
- **Brand voice.** Compared against the style guide document in Google Drive, read with the existing Drive MCP server.
- **Risk flags.** Claims, legal or sensitive topics, personal information, anything likely to need a second look.
- **Duplicates and conflicts.** Posts on the same platform scheduled near this one (`listNear`) that repeat or collide with it.

The review's FIRST line is:

```
VERDICT: OK | REVISE | BLOCK
```

- `OK`: no issues found.
- `REVISE`: fixable issues; the proposer should edit.
- `BLOCK`: a hard problem (limit violation, missing required media, serious risk).

The verdict is parsed (`/^VERDICT: (OK|REVISE|BLOCK)\b/m`) and shown in the card header ("review: OK", or "no verdict" if missing). It is advisory and never changes status; approvers decide.

## 7. Data Model

Table `social_posts` (Postgres, Drizzle; SQLite twin for tests). Migrations `0001_social_posts.sql` and `0002_social_pull.sql`.

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
| `slack_view_id` | text, unique | Slack view id of the proposal; makes proposals idempotent |
| `pull_reason` | text, null | Required reason from Request pull |
| `pull_requested_by` | text, null | Slack user ID |
| `pulled_by` | text, null | Slack user ID |
| `pulled_at` | timestamptz, null | When marked pulled |
| `nudged_at` | timestamptz, null | When the missed-time nudge was sent |
| `created_at` | timestamptz | Row creation |
| `updated_at` | timestamptz | Bumped on every update; the optimistic-concurrency version |

## 8. SQS Message Types

Defined in `packages/db/src/social-store.ts` and imported from `@arbor/db` by both the Lambda and the agent.

| `type` | Producer | Payload |
|---|---|---|
| `social_post_proposed` | Modal submit | `platform`, `content`, `media_url`, `scheduled_at`, `proposer_id`, `slack_view_id`, `response_url` |
| `social_post_edited` | Edit-modal submit | `post_id`, `version`, `platform`, `content`, `media_url`, `scheduled_at`, `user_id` |
| `social_post_action` | Button click, pull-modal submit | `post_id`, `version`, `action` (`approve`, `object`, `clear_objection`, `mark_posted`, `withdraw`, `request_pull`, `mark_pulled`), `user_id`, `response_url`, `reason` (`request_pull` only) |
| `social_post_nudge` | EventBridge via Lambda, only when posts are due | none |

Modal `callback_id`s are `social_post_modal` and `social_pull_modal`. Button `action_id` is `social_post:<action>`; the value is `<post_id>:<updated_at>`. Edit and Request pull buttons open modals in the Lambda (Edit only for the proposer, and only from `in_review`/`objected`/`approved`). Unknown platforms or actions are ignored with HTTP 200. The agent logs one `[social]` line per message.

The nudge handler selects approved posts with `scheduled_at` past and `nudged_at` null (`listDueForNudge`) and posts one thread reply per post tagging `SOCIAL_APPROVER_IDS`.

## 9. Configuration

| Variable | Component | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | Lambda (new) | Needed for `views.open`; the `trigger_id` expires in 3 seconds, so the Lambda opens the modal itself |
| `SOCIAL_APPROVALS_CHANNEL` | Agent, required | Channel ID where posts are reviewed and approved. Proposals are refused without it |
| `SOCIAL_APPROVER_IDS` | Agent, required | Comma-separated Slack user IDs allowed to approve, object, mark posted, and mark pulled. Proposals are refused without it |

`DATABASE_URL` is already set on both components. See [Runtime Configuration](configuration.md).

## 10. Slack App Changes

- **Slash command** `/propose-post`, Request URL `<API_URL>/slack/commands`.
- **Interactivity & Shortcuts**: enable, Request URL `<API_URL>/slack/interactions`. Receives modal submissions and button clicks.
- **Bot token scopes**: `chat:write` and `commands`. `views.open` needs no extra scope.
- Invite the bot to the approvals channel.

## 11. Decisions and Open Questions

Decided (owner rulings):

- Self-approval is refused: the proposer cannot approve their own post, even if they are an approver.
- Any approver may clear any objection (a single `objected_by` slot). Edit does not clear it.
- One platform per proposal.
- Withdraw: proposer or any approver, from any non-terminal state except `posted`.
- Pull: approvers and the proposer may request it from `posted` with a required reason; only approvers mark it pulled. `pulled` is terminal in v1.
- `withdrawn` is terminal (re-propose); no revive.

Open:

- Who are the approvers (initial `SOCIAL_APPROVER_IDS`)?
- Which Drive document is the style guide? The agent needs a fixed name or ID.
- Restore from `pulled` or `withdrawn`: deferred.

## 12. Future Work

| Item | Trigger |
|---|---|
| Platform API adapters (publish on approval) | Meta app review is complete and/or an X paid API tier is purchased |
| Auto-post at `scheduled_at` | The manual paste/click proves to be the bottleneck (frequent nudges) |
| Slack file upload for media | Approvers or the Drive-link check reject links often enough to be a problem |
| Web UI | Proposers appear who are not in Slack |
