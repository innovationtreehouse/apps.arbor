# How It Works

This document describes the end-to-end operation of the Squirrel agent (display name configurable via `AGENT_NAME`, default `Squirrel`): what happens from the moment a user mentions it in Slack through to the reply appearing in the thread.

## System Components

```
Slack ──────► API Gateway ──────► Lambda (webhook receiver)
                                       │
                                       ├── SQS queue ──────► ECS Fargate (agent)
                                       │                          │
                                       └── PostgreSQL             ├── Claude API
                                           (URL config)           ├── Google Drive MCP
                                                                   ├── GitHub MCP
                                                                   └── URL Fetcher MCP
                                                                          │
                                                                       PostgreSQL
                                                                     (URL allowlist)
```

---

## Message Flow

### 1. User mentions @Squirrel

When a user types `@Squirrel find the Q4 report` in a Slack channel:

1. Slack sends a signed HTTP POST to the Lambda webhook endpoint (`/slack/events`).
2. Lambda verifies the `X-Slack-Signature` HMAC-SHA256 header using the app's signing secret. Requests older than 5 minutes are rejected with HTTP 401.
3. Lambda checks the event type. Only `app_mention` events from non-bot users are processed; everything else gets HTTP 200 with an empty body (Slack requires a quick acknowledgment).

### 2. Agent startup

Before forwarding the event, Lambda ensures the agent container is running:

1. Lambda calls `ListTasks` on ECS, filtering by cluster and task family with `desiredStatus: RUNNING`.
2. If no task is running, Lambda calls `RunTask` to start the Fargate container. The container uses the network configuration (subnets, security groups) from Lambda's environment.
3. The container starts, runs the SQS polling loop, and idles until a message arrives. It exits automatically after `IDLE_TIMEOUT` minutes (default 15) with no activity.

Lambda then writes the Slack event as JSON to the SQS queue and returns HTTP 200 to Slack immediately — the agent response is asynchronous.

### 3. Agent picks up the event

The agent container runs a tight SQS long-poll loop (20-second wait):

1. It receives the Slack event from SQS.
2. It calls `conversations.replies` to fetch the full thread history (up to `THREAD_HISTORY_LIMIT` messages, default 50). This gives the agent context for the conversation.
3. It builds a prompt from the thread history and the current message, then calls `runAgent()`.
4. It posts the agent's response back to the same Slack thread via `chat.postMessage`.
5. It writes an audit record to the `audit_log` table (channel, thread, user, prompt, response, model, duration). Audit write failures are logged but do not fail the event — the response is always posted first.
6. It deletes the SQS message to acknowledge processing.
6. Any message processing error is logged but does not crash the loop — the container keeps polling.

If the loop receives no messages for `IDLE_TIMEOUT` minutes, the container calls `process.exit(0)` and ECS terminates it. The next mention will trigger Lambda to start a fresh container.

### 4. Agent reasoning

`runAgent()` calls the Claude Agent SDK's `query()` function with three MCP servers attached. If the call throws (e.g. an MCP server crashes or times out), `runAgent()` retries up to `MAX_MCP_RETRIES` times (default 2) with exponential backoff starting at 1 second, capped at 10 seconds. All three attempts failing causes the error to propagate to the SQS loop, which logs it and moves on to the next message.

**Google Drive** (`@modelcontextprotocol/server-gdrive`)
- Authenticates using a Google service account (`GOOGLE_CREDENTIALS` env var, JSON string).
- Lets Claude search and read files from Google Drive (Docs, Sheets, PDFs, etc.).
- The service account must have been granted access to the relevant Drive folders.

**GitHub** (`@modelcontextprotocol/server-github`)
- Authenticates using a personal access token (`GITHUB_TOKEN`).
- Lets Claude read repositories, search code, view issues and pull requests.
- The token scope determines what repositories are accessible.

**URL Fetcher** (custom `mcp-url-fetcher` package)
- Lets Claude fetch content from a curated, admin-managed allowlist of URLs.
- URLs not on the allowlist are rejected. This prevents the agent from browsing arbitrary web pages.
- The allowlist is loaded from PostgreSQL on startup and refreshed every `URL_POLL_INTERVAL_S` seconds (default 60).
- Supported tools: `url_list` (show available URLs) and `url_fetch` (retrieve page content).
- Content is limited to text and JSON types; binary content is rejected.
- Responses are truncated at 20,000 characters to avoid filling the context window.

Claude decides which tools to use, in what order, based on the user's question. The agent runs until Claude produces a final result. The result text is trimmed to 3,900 characters before posting to Slack (the API limit is 4,000 characters per message).

---

## URL Allowlist Management

The allowlist is managed through the `/squirrel-admin` Slack slash command. Only user IDs listed in `ADMIN_USER_IDS` can use it.

### Commands

| Command | Effect |
|---|---|
| `/squirrel-admin list` | Show all configured URLs with status and description |
| `/squirrel-admin add <url> <description>` | Add a URL to the allowlist (must start with `https://`) |
| `/squirrel-admin remove <url>` | Remove a URL |
| `/squirrel-admin test <url>` | Fetch the URL and show a 500-character preview |
| `/squirrel-admin model [<model-id>]` | Show or set the active Claude model |
| `/squirrel-admin audit [<limit>]` | Show recent agent interactions (default 10, max 50) |
| `/squirrel-admin audit-thread <channel> <thread_ts>` | Show all interactions for a specific thread |
| `/squirrel-admin social-posts` | List open social posts (id, platform, status, scheduled time, proposer) |
| `/squirrel-admin help` | Show command reference |

All responses are ephemeral (visible only to the command sender). The `add` command enforces a configurable limit (`MAX_URL_COUNT`, default 100) to prevent runaway table growth. All URLs must use HTTPS.

### Database Schema

The URL allowlist is stored in a PostgreSQL table managed by the `@arbor/db` package using Drizzle ORM. The schema is defined in `packages/db/src/schema.ts`.

```sql
CREATE TABLE url_config (
  url         TEXT PRIMARY KEY,
  description TEXT        NOT NULL,
  enabled     BOOLEAN     NOT NULL DEFAULT true,
  added_by    TEXT        NOT NULL,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

| Column | Type | Description |
|---|---|---|
| `url` | text (PK) | The full URL |
| `description` | text | Human-readable description shown to the agent |
| `enabled` | boolean | Whether the URL is active |
| `added_by` | text | Slack user ID of the person who added it |
| `added_at` | timestamptz | When the entry was created |

The URL Fetcher MCP server queries only `enabled = true` rows via `PostgresUrlStore.listEnabled()`. Disabled URLs remain in the table and are visible in `/squirrel-admin list` but are not fetchable by the agent.

The `audit_log` table records every agent interaction for operational visibility:

```sql
CREATE TABLE audit_log (
  id          SERIAL PRIMARY KEY,
  channel     TEXT        NOT NULL,
  thread_ts   TEXT        NOT NULL,
  user_id     TEXT        NOT NULL,
  prompt      TEXT        NOT NULL,
  response    TEXT        NOT NULL,
  model       TEXT,
  duration_ms INTEGER     NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### Data access abstraction

All database access goes through typed store interfaces in `packages/db/src/store.ts` (`UrlStore`, `ConfigStore`, `AuditStore`). The `createStores(connectionString)` factory returns matching implementations: PostgreSQL for `postgres://` URLs, SQLite for everything else. This allows local development without a running database server.

---

## Signature Verification

Every request from Slack is verified before any processing occurs. Lambda computes:

```
HMAC-SHA256(SLACK_SIGNING_SECRET, "v0:{timestamp}:{body}")
```

and compares it to the `X-Slack-Signature` header using `crypto.timingSafeEqual` (constant-time comparison to prevent timing attacks). Requests with a timestamp more than 5 minutes old are rejected regardless of signature validity.

---

## Prompt Construction

The agent prompt includes:

1. **System prompt** — instructs Claude to act as the configured agent name (`AGENT_NAME`), describes available tools (Drive, GitHub, URL Fetcher), and sets a 3,900-character response length limit.
2. **Thread history** — all previous messages in the thread, formatted as `{label}: {text}`. Bot messages are labeled with `AGENT_NAME`; human messages use the Slack user ID.
3. **Current message** — the text of the `app_mention` event that triggered this run.

Thread history older than the last message is included for context but the current message is not duplicated.

---

## Error Handling

| Scenario | Behavior |
|---|---|
| Invalid Slack signature | HTTP 401; request dropped |
| Non-mention Slack event | HTTP 200; silently ignored |
| Bot message (self-loop prevention) | HTTP 200; silently ignored |
| ECS task start failure | Error propagates; Lambda returns error to Slack (Slack will not show this to the user since the 3-second window has passed) |
| Agent processing error | Logged; SQS message is not deleted (it will retry or go to DLQ after max receive count) |
| Fetch error in URL Fetcher | Returns `isError: true` to Claude; agent informs user |
| Slack API error on reply | Logged; agent loop continues |

---

## Concurrency

The Lambda scales horizontally. Multiple simultaneous Slack events can arrive and each Lambda invocation independently checks for a running ECS task. If two Lambda invocations race and both find no task, both will call `RunTask` — ECS handles this gracefully by starting two tasks. The second task will idle and shut down after `IDLE_TIMEOUT` without receiving work (since SQS delivers each message to only one consumer).

Social post transitions are safe under two tasks: each is a conditional update on `updated_at`, and stale clicks are refused (see [Social Post Approval](social-posts.md)).

This is intentional: simplicity over strict singleton enforcement. If strict single-task behavior is required, a PostgreSQL advisory lock or a short-TTL row in `url_config` could serve as a distributed lock around `RunTask`.
