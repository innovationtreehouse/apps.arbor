# Arbor: Design Document

## 1. Overview and Goals

### Purpose

Squirrel is the default name of the AI agent that operates as a named member of a Slack workspace. The display name is configurable via the `AGENT_NAME` environment variable (default: `Squirrel`). It accepts natural-language requests via Slack mentions, reasons over multiple external data sources (Google Drive, GitHub, curated web URLs), and returns synthesized responses within the Slack thread.

### Goals

- Present the agent as a recognizable bot user (display name set by `AGENT_NAME`, default `Squirrel`) with its own avatar in Slack channels
- Incorporate Slack thread history so the bot maintains conversational context within a thread
- Enable the agent to search and read Google Drive documents (service account auth)
- Enable the agent to query GitHub repositories, issues, and pull requests
- Enable the agent to fetch and summarize content from a configurable list of known URLs, managed via an admin interface
- Keep MCP server credentials isolated per integration via environment variables
- Deploy as Docker containers started on-demand by a Lambda function; containers run persistently once started

### Non-Goals

- General web crawling or open-ended web search
- Multi-workspace Slack deployments
- Per-user OAuth for Google Drive

---

## 2. Architecture

### High-Level Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        Slack Workspace                           │
│                                                                  │
│   User  ──@Squirrel mention──►  #channel / thread               │
│   Admin ──/squirrel-admin──────────────────┐                    │
│                                        │   │                    │
│                              Slack Events API (webhook)          │
│                              Slack Slash Commands                │
└────────────────────────────────────────┼───┼─────────────────────┘
                                         │   │  HTTPS POST
                                         ▼   ▼
                              ┌─────────────────────┐
                              │    AWS Lambda        │
                              │  POST /slack/events  │
                              │  POST /slack/commands│
                              │                      │
                              │ Events:              │
                              │ 1. Verify signature  │
                              │ 2. ACK Slack (200)   │
                              │ 3. Start/check       │
                              │    ECS Fargate task  │
                              │ 4. Forward → SQS     │
                              │                      │
                              │ Commands:            │
                              │ 1. Verify signature  │
                              │ 2. Check admin auth  │
                              │ 3. Read/write        │
                              │    PostgreSQL        │
                              │ 4. Return ephemeral  │
                              └──────┬──────┬────────┘
                                     │      │
                                  SQS│      │PostgreSQL
                                     │      │(url_config)
                                     ▼      ▼
                                        │  ECS RunTask or
                                        │  SQS → container
                                        ▼
┌──────────────────────────────────────────────────────────────────┐
│                    ECS Fargate Container                         │
│                    (arbor-agent, Docker)                      │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │             Slack Event Handler                          │   │
│  │  - Fetches thread history via Slack API                  │   │
│  │  - Builds prompt with full thread context                │   │
│  │  - Calls agent query()                                   │   │
│  │  - Posts result via chat.postMessage (as Squirrel)       │   │
│  └───────────────────────┬──────────────────────────────────┘   │
│                          │                                       │
│  ┌───────────────────────▼──────────────────────────────────┐   │
│  │         Claude Agent SDK  —  query()                     │   │
│  │  Model: anthropic/claude-opus-4.6 (via OpenRouter)       │   │
│  └──────┬──────────────┬─────────────────┬──────────────────┘   │
│         │ stdio        │ stdio           │ stdio                │
│         ▼              ▼                 ▼                      │
│  ┌────────────┐ ┌────────────┐ ┌──────────────────────────┐    │
│  │  MCP       │ │  MCP       │ │  MCP                     │    │
│  │  gdrive    │ │  github    │ │  url-fetcher             │    │
│  │            │ │            │ │  (custom)                │    │
│  └─────┬──────┘ └─────┬──────┘ └────────────┬─────────────┘    │
└────────┼──────────────┼─────────────────────┼──────────────────┘
         │              │                      │
         ▼              ▼                      ▼
  Google Drive     GitHub REST          Configured URLs
  API (service     API (PAT)            (fetched via HTTP;
  account)                               list from DB/config)
```

### Component Boundaries

| Layer | Responsibility |
|---|---|
| **Slack Layer** | Message delivery, Squirrel identity rendering, slash command routing |
| **Lambda Layer** | Webhook receipt, signature verification, Slack ACK, container orchestration, admin command handling |
| **PostgreSQL** | Persistent URL allowlist (`url_config`) and agent config (`agent_config`); written by Lambda admin handler, read by `url-fetcher` MCP |
| **Agent Container** | Event handling, thread context assembly, agent reasoning, response posting |
| **MCP Layer** | Independent child processes per integration, each holding its own credentials |

---

## 3. Components

### 3.1 Slack App (api.slack.com/apps)

| Setting | Value |
|---|---|
| App Name | Your `AGENT_NAME` value (e.g. `Squirrel`) |
| Bot Display Name | Your `AGENT_NAME` value (e.g. `Squirrel`) |
| Default Username | lowercase of your app name (e.g. `squirrel`) |
| App Icon | Custom avatar PNG (512×512) |
| Event Subscriptions | `app_mention`, `message.channels` (for thread replies) |
| Request URL | Lambda function URL or API Gateway endpoint |
| Bot Token Scopes | `app_mentions:read`, `chat:write`, `channels:read`, `channels:history`, `groups:history`, `files:read`, `users:read` |

### 3.2 AWS Lambda (Webhook + Admin Handler)

The Lambda function is the only always-on compute. It handles two routes:

**`POST /slack/events`** — Slack event webhook (`app_mention`):
1. Verify `X-Slack-Signature` — reject if invalid
2. Return HTTP 200 immediately (Slack requires ACK within 3s)
3. Check whether the ECS Fargate agent task is RUNNING; if not, call `ecs:RunTask`
4. Forward the event payload to the agent via SQS

**`POST /slack/commands`** — Slack slash command (`/squirrel-admin`):
1. Verify `X-Slack-Signature`
2. Check `user_id` against `ADMIN_USER_IDS` env var — return ephemeral error if unauthorized
3. Parse subcommand and args
4. Read/write PostgreSQL (`url_config` or `agent_config` tables)
5. Return ephemeral JSON response inline (slash commands support synchronous response)

The Lambda holds no AI logic and no agent state.

### 3.2a PostgreSQL (`url_config`, `agent_config`)

Stores the URL allowlist and agent configuration managed via `/squirrel-admin`. Written by the Lambda admin handler; `url_config` is read by the `url-fetcher` MCP server on a 60-second poll interval, and `agent_config` is read by the agent on every message.

**`url_config`** — URL allowlist:

| Column | Type | Description |
|---|---|---|
| `url` (PK) | text | The URL |
| `description` | text | Human-readable label shown to the model |
| `added_by` | text | Slack user ID of the admin who added it |
| `added_at` | timestamptz | When the entry was created |
| `enabled` | boolean | Whether the URL is active |

**`agent_config`** — Key-value agent settings (e.g. `model`):

| Column | Type | Description |
|---|---|---|
| `key` (PK) | text | Setting name (e.g. `model`) |
| `value` | text | Setting value |

### 3.3 ECS Fargate Container (`arbor-agent`)

A long-running Docker container that handles the actual agent work. It may be started by Lambda on first use and kept running to avoid cold-start latency on subsequent requests.

**Receives:** Slack event payloads (from Lambda via SQS or HTTP)

**Responsibilities:**
1. Fetch the full Slack thread history using `conversations.replies`
2. Build a prompt that includes thread context + the new user message
3. Call `query()` with MCP server configs
4. Post the agent's response to Slack via `chat.postMessage`

**Optionally started by Lambda:** The Lambda checks if the container task is in RUNNING state. If not, it calls `ecs:RunTask` to start it. Once started, the task processes queued events. A configurable idle timeout shuts down the task when no events have arrived for a defined period.

### 3.4 Claude Agent SDK — `query()`

Manages the agentic loop: model call → tool dispatch to MCP child processes → feed results back → repeat until final response.

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: buildPrompt(threadHistory, newMessage),
  system: "You are Squirrel, a research assistant in this Slack workspace...",
  options: {
    mcpServers: {
      gdrive: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-gdrive"],
        env: { GOOGLE_CREDENTIALS: process.env.GOOGLE_CREDENTIALS }
      },
      github: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN }
      },
      urls: {
        command: "node",
        args: ["./mcp-servers/url-fetcher/index.js"],
        env: {
          ALLOWED_URLS: process.env.ALLOWED_URLS,  // from admin config
          CONFIG_DB_URL: process.env.CONFIG_DB_URL
        }
      }
    }
  }
})) {
  if (message.type === "result" && message.subtype === "success") {
    await postToSlack(channel, threadTs, message.result);
  }
}
```

### 3.5 MCP Server: `server-gdrive`

Pre-built server. Exposes `gdrive_search`, `gdrive_read_file`, `gdrive_list_files`. Authenticates using a Google service account key JSON stored in `GOOGLE_CREDENTIALS`. The service account must be granted read access to the folders/drives it should search.

### 3.6 MCP Server: `server-github`

Pre-built server. Exposes `github_search_code`, `github_list_issues`, `github_get_pull_request`, `github_get_file_contents`. Authenticates via `GITHUB_TOKEN` (fine-grained PAT scoped to specific repos).

### 3.7 MCP Server: `url-fetcher` (Custom)

A custom MCP server that fetches and returns the text content of URLs from an admin-managed allowlist.

**Tools exposed:**
- `url_fetch(url: string)` — fetches and returns cleaned text content of a URL; rejects URLs not on the allowlist
- `url_list()` — returns the current list of configured URLs with their descriptions

**URL configuration:** The allowlist is stored in a config DB or parameter store and loaded at server startup (with optional hot-reload). Each entry includes:
- `url`: the URL to fetch
- `description`: human-readable label the model uses to decide when to fetch it
- `refresh_interval`: optional cache TTL

**Admin interface:** A separate web UI (or Slack slash command) allows admins to add, remove, and describe URLs without redeploying the container. Changes propagate to running containers via the config DB.

---

## 4. Slack Bot Identity

When `chat.postMessage` is called with `xoxb-<SLACK_BOT_TOKEN>`, Slack automatically renders the message as "Squirrel" with its configured avatar. No `username` or `icon_url` parameters are used — the bot token alone establishes identity.

```http
POST https://slack.com/api/chat.postMessage
Authorization: Bearer xoxb-<SLACK_BOT_TOKEN>

{
  "channel": "C0XXXXXXX",
  "thread_ts": "1234567890.123456",
  "text": "Here is what I found..."
}
```

### Setup Steps

1. `api.slack.com/apps` → Create New App (From Scratch) → name it your `AGENT_NAME` value (e.g. `Squirrel`)
2. App Home → enable Bot User → Display Name: your `AGENT_NAME` value, Username: lowercase version
3. Basic Information → upload avatar PNG
4. OAuth & Permissions → add bot token scopes listed in §3.1
5. Event Subscriptions → enable → set Request URL to Lambda endpoint → subscribe to `app_mention`
6. Install to workspace → copy `xoxb-...` token → store as `SLACK_BOT_TOKEN`
7. In Slack, `/invite @squirrel` in each target channel

---

## 5. Thread Context

Before calling `query()`, the agent fetches the full thread history and prepends it to the prompt:

```typescript
async function buildPrompt(channel: string, threadTs: string, newText: string): Promise<string> {
  const history = await slack.conversations.replies({
    channel,
    ts: threadTs,
    limit: 50  // configurable cap
  });

  const prior = history.messages
    .slice(0, -1)  // exclude the triggering message
    .map(m => `${m.username ?? m.bot_profile?.name ?? "user"}: ${m.text}`)
    .join("\n");

  return prior
    ? `Conversation so far:\n${prior}\n\nNew message: ${newText}`
    : newText;
}
```

**Token cost consideration:** Long threads increase prompt token usage. A configurable `THREAD_HISTORY_LIMIT` (message count or character count) prevents runaway costs on heavily active threads.

---

## 6. Authentication and Credentials

| Environment Variable | Used By | Purpose |
|---|---|---|
| `SLACK_SIGNING_SECRET` | Lambda | Verify inbound webhook signatures |
| `SLACK_BOT_TOKEN` | Agent container | Post messages, fetch thread history |
| `ADMIN_USER_IDS` | Lambda | Comma-separated Slack user IDs authorized for `/squirrel-admin` |
| `OPENROUTER_API_KEY` | Claude Agent SDK | OpenRouter's Anthropic-compatible endpoint; models use OpenRouter IDs (e.g. `anthropic/claude-opus-4.6`) |
| `GOOGLE_CREDENTIALS` | `server-gdrive` | Google service account key (JSON) |
| `GITHUB_TOKEN` | `server-github` | GitHub fine-grained PAT |
| `DATABASE_URL` | Lambda, Agent, `url-fetcher` MCP | PostgreSQL connection string |
| `URL_POLL_INTERVAL_S` | `url-fetcher` MCP | Seconds between PostgreSQL reloads (default: 60) |

All secrets are stored in AWS Secrets Manager or SSM Parameter Store and injected into the Lambda and ECS task definitions at deploy time. No secrets are stored in environment files or Docker images.

Each MCP child process receives only the environment variables it needs.

---

## 7. Data Flow

Tracing "@Squirrel what does the Q4 plan say about the API redesign?" in a thread with prior context:

```
1. User sends message → Slack fires app_mention to Lambda endpoint

2. Lambda:
   - Verifies X-Slack-Signature
   - Returns HTTP 200 immediately
   - Checks ECS task status → if not RUNNING, calls ecs:RunTask
   - Sends event payload to SQS queue

3. Agent container dequeues event:
   - Calls conversations.replies to fetch thread history (up to THREAD_HISTORY_LIMIT)
   - Builds prompt: prior thread messages + new user message

4. Agent calls query() with prompt and MCP server configs

5. SDK → OpenRouter (first call):
   - Model receives prompt + tool catalog
   - Plans: search Drive for "Q4 plan", check configured docs URLs for API context

6. SDK → server-gdrive: gdrive_search("Q4 plan")
   → returns matching documents

7. SDK → server-gdrive: gdrive_read_file(<doc id>)
   → returns document text

8. SDK → url-fetcher: url_fetch("https://internal-wiki.example.com/api-redesign")
   → URL is on allowlist; fetcher returns page text

9. SDK → OpenRouter (final call):
   - Model synthesizes Drive content + wiki page content
   - Produces answer

10. Container calls chat.postMessage (bot token, thread_ts)
    → Squirrel posts answer in thread
```

### Latency

- Lambda cold start: ~200ms (negligible — only runs webhook ACK logic)
- ECS Fargate cold start: 20–40s (only incurred if container was idle and shut down)
- MCP tool calls: 1–5s each depending on external API latency
- Model inference: 3–10s per call

For a warm container with 3–5 tool calls and 2–3 inference calls, total response time is typically 15–30 seconds. Squirrel should post an ephemeral "Searching..." acknowledgment immediately after receiving the event to set user expectations.

---

## 8. Container Lifecycle

```
Slack event
     │
     ▼
  Lambda
     │
     ├─ Task RUNNING? ──yes──► forward event to SQS
     │
     └─ Task NOT RUNNING ──► ecs:RunTask → task starts → forward event to SQS

ECS Task
     │
     ├─ Processes events from SQS
     │
     └─ No events for IDLE_TIMEOUT minutes ──► task exits (self-termination)
```

**Key parameters:**

| Parameter | Description | Default |
|---|---|---|
| `IDLE_TIMEOUT` | Minutes of inactivity before container self-terminates | 15 |
| `THREAD_HISTORY_LIMIT` | Max messages fetched per thread | 50 |
| `MAX_MCP_RETRIES` | Retries for failed MCP tool calls | 2 |

---

## 9. Admin Interface (URL Configuration)

The admin interface is implemented as a Slack slash command `/squirrel-admin`. It is handled by the same Lambda function as the webhook receiver, via a separate route. Only authorized workspace admins may use it.

### 9.1 Slack App Setup

In addition to the event subscription, the Slack App requires:

- **Slash Command**: `/squirrel-admin` → points to the same Lambda endpoint (e.g., `POST /slack/commands`)
- **Additional Bot Scopes**: `commands` (automatically granted when a slash command is created)
- **Admin Authorization**: enforced in the Lambda handler by checking `user_id` against an `ADMIN_USER_IDS` environment variable (comma-separated Slack user IDs)

### 9.2 Commands

All commands are invoked as `/squirrel-admin <subcommand> [args]`. Responses are ephemeral (visible only to the invoking user).

| Command | Usage | Description |
|---|---|---|
| `list` | `/squirrel-admin list` | Show all configured URLs with their descriptions and last-fetched status |
| `add` | `/squirrel-admin add <url> <description>` | Add a URL to the allowlist with a human-readable label |
| `remove` | `/squirrel-admin remove <url>` | Remove a URL from the allowlist |
| `test` | `/squirrel-admin test <url>` | Fetch the URL and return a preview of the content Squirrel would receive (first 500 chars) |
| `model` | `/squirrel-admin model [<model-id>]` | Show the active Claude model, or set it to a new one |
| `help` | `/squirrel-admin help` | Show available commands |

**Examples:**
```
/squirrel-admin add https://wiki.example.com/api-docs API Documentation Wiki
/squirrel-admin add https://notion.so/abc123 Q4 Planning Document
/squirrel-admin list
/squirrel-admin test https://wiki.example.com/api-docs
/squirrel-admin remove https://notion.so/abc123
```

### 9.3 Config Storage (PostgreSQL)

URL configurations are stored in the `url_config` PostgreSQL table. Agent settings (such as the active model) are stored in the `agent_config` table. Both are managed via Drizzle ORM in the `@arbor/db` package. See §3.2a for the full schema.

The Lambda handler reads/writes both tables for admin commands. The `url-fetcher` MCP server reads `url_config` on a 60-second poll interval. The agent reads `agent_config` on every message.

### 9.4 Config Propagation

```
Admin: /squirrel-admin add <url> <desc>
           │
           ▼
       Lambda handler
       - Verifies admin authorization
       - Validates URL format
       - Writes to PostgreSQL (url_config)
       - Returns ephemeral confirmation
           │
           ▼ (within ~60s)
       url-fetcher MCP server
       - Polls PostgreSQL on interval
       - Refreshes in-memory allowlist
       - New URL available to agent

Admin: /squirrel-admin model <model-id>
           │
           ▼
       Lambda handler
       - Writes to PostgreSQL (agent_config key=model)
           │
           ▼ (next Slack message)
       Agent container
       - Reads model from agent_config on each event
       - Passes model to runAgent()
```

No container restart is required. Changes propagate on the next poll cycle (≤60 seconds).

### 9.5 Authorization

The Lambda handler checks `ADMIN_USER_IDS` (env var, comma-separated Slack user IDs) before executing any admin command. Non-admins receive an ephemeral error: `"You are not authorized to use /squirrel-admin."` The check uses the `user_id` field in the Slack slash command payload, which cannot be spoofed (the payload is verified by `X-Slack-Signature` before any processing).

### 9.6 Input Validation

- URLs must start with `https://`
- URLs must be reachable (the `test` command verifies this before `add` allows it — or use `add` directly and `test` separately)
- Description is required and must be non-empty
- Maximum 100 URLs in the allowlist (configurable via `MAX_URL_COUNT` env var)

---

## 10. Key Design Decisions

### Lambda + ECS Fargate (not Lambda-only)

Lambda's 15-minute timeout and 10GB memory cap are insufficient for long agentic loops with multiple MCP tool calls. ECS Fargate containers have no timeout and can hold all MCP child processes alive across multiple requests, eliminating MCP server startup overhead per request. Lambda handles only the time-sensitive webhook ACK and container orchestration.

### MCP Servers as Child Processes (stdio)

Standard MCP deployment model. Each server runs in isolation with its own credentials. Servers start once when the container starts and stay alive across multiple `query()` calls, amortizing startup cost.

### Response Posted by Host, Not via MCP

The agent container calls `chat.postMessage` directly. Routing posting through an MCP tool call would make the response path non-deterministic (the model would need to decide to call a post tool). Direct posting is synchronous and correctly thread-aware.

### Service Account for Google Drive

A service account with specific folders/drives shared to it provides administrator-controlled, predictable access. Per-user OAuth would require each Slack user to pre-authorize the bot. The service account's access boundary is a security feature — it cannot read documents that haven't been explicitly shared with it.

### Curated URL Allowlist (Not Open Web Search)

Rather than a general search capability, Squirrel fetches specific known URLs. This keeps the agent focused on authoritative organizational sources, avoids hallucinations from unpredictable web content, and gives admins control over the agent's knowledge surface.

### No Streaming to Slack

`chat.postMessage` is not a streaming API. Streaming via repeated `chat.update` calls is complex and rate-limited. Post the full response after `query()` resolves; acknowledge immediately with an ephemeral message.

---

## 11. Security Considerations

- Verify `X-Slack-Signature` on every inbound webhook in the Lambda handler; reject without processing if invalid
- All secrets in AWS Secrets Manager or SSM; never in code, Docker images, or env files
- Google service account scoped to `drive` (read/write); only folders explicitly shared with it are accessible
- `GITHUB_TOKEN` uses fine-grained PAT limited to specific repositories and `contents:read` + `issues:read` + `pull_requests:read` scopes
- `url-fetcher` MCP server rejects any URL not on the admin-managed allowlist — the model cannot instruct it to fetch arbitrary URLs
- Slack responses truncated to ≤4,000 characters before posting (Slack API limit)
- ECS task runs in a private VPC subnet; outbound internet access via NAT gateway only
- IAM role for ECS task follows least-privilege: only `secretsmanager:GetSecretValue` for its own secrets and `sqs:ReceiveMessage`/`DeleteMessage` for its queue

---

## 12. Extension Points

- **New data sources**: Add an MCP server config to the `mcpServers` map — the model discovers new tools automatically
- **New invocation surfaces**: `query()` is surface-agnostic; a web UI, CLI, or scheduled job can use the same agent
- **Custom tools**: Write additional MCP servers in-house for internal databases, CRMs, or wikis
- **Model upgrades**: Model identifier is a single config parameter; no architectural changes required
- **Multi-workspace**: Add workspace routing in the Lambda layer; each workspace gets its own bot token and potentially its own ECS task
