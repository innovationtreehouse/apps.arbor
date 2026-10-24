# Runtime Configuration

Environment variables for the two deployed components: the Lambda webhook receiver and the ECS Fargate agent container.

Sensitive values are stored in AWS Secrets Manager under the `arbor/` prefix and injected at runtime — see [AWS Setup](aws-setup.md) for provisioning details. Non-sensitive values are set directly as environment variables.

---

## Lambda (webhook receiver)

| Variable | Sensitive | Default | Description |
|---|---|---|---|
| `SLACK_SIGNING_SECRET` | Yes | — | Slack app signing secret, used to verify the HMAC-SHA256 signature on every inbound request |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string (`postgres://user:pass@host/db`) |
| `SQS_QUEUE_URL` | No | — | SQS queue URL; Lambda sends Slack events here for the agent to process |
| `ECS_CLUSTER` | No | — | ECS cluster name (e.g. `arbor`) |
| `ECS_TASK_FAMILY` | No | — | Task family name used when checking for a running task (e.g. `arbor-agent`) |
| `ECS_TASK_DEFINITION` | No | — | Task definition ARN or `family:revision` used when launching a new task |
| `SUBNET_IDS` | No | — | Comma-separated private subnet IDs for Fargate task placement |
| `SECURITY_GROUP_IDS` | No | — | Comma-separated security group IDs applied to the Fargate task |
| `ADMIN_USER_IDS` | No | — | Comma-separated Slack user IDs permitted to use `/squirrel-admin` |
| `AGENT_NAME` | No | `Squirrel` | Bot display name shown in admin help text |
| `MAX_URL_COUNT` | No | `100` | Maximum number of URLs allowed in the allowlist |

---

## Agent (ECS Fargate container)

The agent container also runs the `mcp-url-fetcher` MCP server in-process, which shares the same environment.

| Variable | Sensitive | Default | Description |
|---|---|---|---|
| `OPENROUTER_API_KEY` | Yes | — | OpenRouter API key (`sk-or-…`); the Claude Agent SDK is pointed at OpenRouter's Anthropic-compatible endpoint |
| `OPENROUTER_BASE_URL` | No | `https://openrouter.ai/api` | OpenRouter base URL |
| `SLACK_BOT_TOKEN` | Yes | — | Slack bot OAuth token (`xoxb-…`) used to post replies and fetch thread history |
| `DATABASE_URL` | Yes | — | Same PostgreSQL connection string as Lambda |
| `GOOGLE_CREDENTIALS` | Yes | — | Google service account JSON as a single-line string; grants Drive API read/write access |
| `GITHUB_TOKEN` | Yes | — | GitHub PAT for the GitHub MCP server; token scopes determine accessible repositories |
| `SQS_QUEUE_URL` | No | — | Same SQS queue URL as Lambda |
| `AWS_REGION` | No | — | AWS region (e.g. `us-east-1`) |
| `AGENT_NAME` | No | `Squirrel` | Bot display name used in the system prompt and thread message labels |
| `MODEL` | No | `anthropic/claude-opus-4.6` | OpenRouter model ID used as fallback when no model is set in `agent_config` |
| `IDLE_TIMEOUT` | No | `15` | Minutes of SQS inactivity before the container calls `process.exit(0)` |
| `THREAD_HISTORY_LIMIT` | No | `50` | Maximum number of prior Slack messages to include as thread context |
| `URL_POLL_INTERVAL_S` | No | `60` | How often the URL Fetcher MCP server refreshes the allowlist from the database, in seconds |
| `MAX_MCP_RETRIES` | No | `2` | Number of times to retry a failed `runAgent()` call before giving up; uses exponential backoff starting at 1s |
| `AGENT_TIMEOUT_S` | No | `240` | Overall deadline in seconds for one `runAgent()` call, retries included; the query is aborted and the event fails when it passes. Keep it below the SQS `VisibilityTimeout` (300) so a slow message is not redelivered |
| `AGENT_MAX_TURNS` | No | `30` | Maximum agent turns (model responses) per query before the SDK stops it |
| `ARBOR_MODEL_FETCH` | No | `google/gemini-3.5-flash-lite` | OpenRouter model that condenses each fetched document into an evidence card; overridden by `agent_config` key `model:fetch` |
| `ARBOR_MODEL_DECIDE` | No | `google/gemini-3.8-flash` | OpenRouter model that picks which evidence cards answer the question; overridden by `agent_config` key `model:decide` |
| `TBA_AUTH_KEY` | Yes | — | The Blue Alliance API v3 key (`X-TBA-Auth-Key`). Unset: the TBA source reports "not configured" |
| `SLACK_USER_TOKEN` | Yes | — | Slack user token (`xoxp-…`) with `search:read`, used only for `search.messages` (public-channel results only). Unset: the Slack source scans 14 days of public channels the bot has joined |

---

---

## Runtime model override

The active model (any OpenRouter model ID) can be changed at runtime without redeploying, using the `/squirrel-admin model` slash command:

```
/squirrel-admin model                          # show current model
/squirrel-admin model anthropic/claude-opus-4.6          # switch to Opus
/squirrel-admin model anthropic/claude-sonnet-4.6        # switch to Sonnet
/squirrel-admin model anthropic/claude-haiku-4.5  # switch to Haiku
```

The model is stored in the `agent_config` PostgreSQL table under the key `model`. It takes effect on the next message the agent processes — no container restart required. The `MODEL` environment variable serves as the fallback when no value is stored in the database. IDs must be `provider/model`; the command rejects bare IDs and warns when a stored pre-OpenRouter value (e.g. `claude-opus-4-6`) is active. Non-Anthropic models on OpenRouter may handle the MCP tool schema less reliably.

---

## Research sources

Before each non-discretion reply the agent runs a research pre-pass (`packages/agent/src/retrieval/`): plan search terms and sources, fetch in parallel (at most 4 documents per source, 12 total; sources still running after 25 s are aborted and reported), condense each document with the `model:fetch` model, let the `model:decide` model pick the cards that answer the question, and append the picked cards (each fenced in an `<evidence>` block) plus a status line per source to the prompt. The main model cites only those cards. The whole pass has a 45 s budget, after which it continues with whatever cards it has, and it shares one `AGENT_TIMEOUT_S` deadline with the agent query. Per-stage token and cost counts go to one `[usage]` log line per message (the audit row has no free field); the main query logs its own `[usage] {"stage":"answer",…}` line.

| Source | Needs | Notes |
|---|---|---|
| FIRST and allowlisted sites | allowlist rows (seeded by migration `0001`) | Fetched through the url-fetcher guard (origin + path-prefix match, private hosts refused, one allowlisted redirect). PDFs such as the game manual are returned as a link, not extracted |
| Chief Delphi | — | Discourse JSON: `/search.json?q=` then `/t/<id>.json` |
| The Blue Alliance | `TBA_AUTH_KEY` | Only when the question names a team (`team 9577`, `frc9577`) |
| Statbotics | — | `api.statbotics.io/v3/team_year/<team>/<year>`, only when a team is named |
| Programs wiki | allowlist row | Queried only when the question mentions programs, the wiki, classes, camps, schedules, registration, policies or fees, so ordinary questions do not wake it. HTTP 503 means the scale-to-zero wiki is waking: inside a message it retries until the source deadline, then reports "the wiki was waking"; `check` retries after 5, 10, 20 and 30 s |
| Google Drive | `GOOGLE_CREDENTIALS` (gdrive proxy) | Offered only while the proxy's `/health` is 200; otherwise the model is told Drive is unavailable |
| Slack | `SLACK_BOT_TOKEN`, optional `SLACK_USER_TOKEN` | Bot scopes used: `channels:read`, `channels:history`. Search needs the user-token scope `search:read` |
| GitHub | `GITHUB_TOKEN` | Issues, PRs, code and README search scoped with `org:innovationtreehouse org:frc9577`. The agent's GitHub MCP tools are read-only |

The seed rows come from the Postgres migration `0001_seed_research_allowlist.sql`. SQLite deployments (local dev) get no seed rows; add the hosts with `/squirrel-admin add`.

`/squirrel-admin check` runs every source once and reports pass, fail or not configured. Change the stage models at runtime with `/squirrel-admin model fetch <id>` and `/squirrel-admin model decide <id>`.

---

## Shared variables

`DATABASE_URL`, `SQS_QUEUE_URL`, and `AGENT_NAME` are used by both components and must be consistent across both deployments.
