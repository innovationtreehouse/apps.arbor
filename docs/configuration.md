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
| `ECS_TASK_FAMILY` | No | — | Task family name (e.g. `arbor-agent`), used both to check for a running task and to launch one (latest active revision) |
| `SUBNET_IDS` | No | — | Comma-separated private subnet IDs for Fargate task placement |
| `SECURITY_GROUP_IDS` | No | — | Comma-separated security group IDs applied to the Fargate task |
| `ADMIN_USER_IDS` | No | — | Comma-separated Slack user IDs permitted to use `/squirrel-admin` |
| `AGENT_NAME` | No | `Squirrel` | Bot display name shown in admin help text |
| `BOT_USER_ID` | No | — | The bot's Slack user ID (`U…`). Channel messages that @mention it are skipped because the `app_mention` event handles them; if unset, a warning is logged and such mentions may get two replies |

---

## Agent (ECS Fargate container)

The agent container also runs the `mcp-url-fetcher` MCP server in-process, which shares the same environment.

| Variable | Sensitive | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic API key passed to the Claude Agent SDK |
| `SLACK_BOT_TOKEN` | Yes | — | Slack bot OAuth token (`xoxb-…`) used to post replies and fetch thread history |
| `DATABASE_URL` | Yes | — | Same PostgreSQL connection string as Lambda |
| `GOOGLE_CREDENTIALS` | Yes | — | Google service account JSON as a single-line string; grants Drive API read/write access |
| `GITHUB_TOKEN` | Yes | — | GitHub PAT for the GitHub MCP server; token scopes determine accessible repositories |
| `SQS_QUEUE_URL` | No | — | Same SQS queue URL as Lambda |
| `AWS_REGION` | No | — | AWS region (e.g. `us-east-1`) |
| `AGENT_NAME` | No | `Squirrel` | Bot display name used in the system prompt and thread message labels |
| `MODEL` | No | `claude-sonnet-4-6` | Claude model ID used as fallback when no model is set in `agent_config` |
| `IDLE_TIMEOUT` | No | `15` | Minutes of SQS inactivity before the container calls `process.exit(0)` |
| `THREAD_HISTORY_LIMIT` | No | `50` | Maximum number of prior Slack messages to include as thread context |
| `URL_POLL_INTERVAL_S` | No | `60` | How often the URL Fetcher MCP server refreshes the allowlist from the database, in seconds |
| `MAX_URL_COUNT` | No | `100` | Maximum number of URLs allowed in the allowlist (enforced by `/squirrel-admin add`) |
| `MAX_MCP_RETRIES` | No | `2` | Number of times to retry a failed `runAgent()` call before giving up; uses exponential backoff starting at 1s |

---

---

## Runtime model override

The active Claude model can be changed at runtime without redeploying, using the `/squirrel-admin model` slash command:

```
/squirrel-admin model                          # show current model
/squirrel-admin model claude-opus-4-6          # switch to Opus
/squirrel-admin model claude-sonnet-4-6        # switch to Sonnet (default)
/squirrel-admin model claude-haiku-4-5-20251001  # switch to Haiku
```

The model is stored in the `agent_config` PostgreSQL table under the key `model`. It takes effect on the next message the agent processes — no container restart required. The `MODEL` environment variable serves as the fallback when no value is stored in the database.

---

## Channel message responses

By default the bot answers only @mentions and direct messages. Replies to other channel messages (top-level and thread replies) are opt-in:

```
/squirrel-admin channel-messages          # show current setting
/squirrel-admin channel-messages on       # respond to channel messages, using discretion
/squirrel-admin channel-messages off      # default
```

The setting is stored in the `agent_config` table under the key `channel_messages`, and the Lambda reads it on each channel message event.

---

## Shared variables

`DATABASE_URL`, `SQS_QUEUE_URL`, and `AGENT_NAME` are used by both components and must be consistent across both deployments.
