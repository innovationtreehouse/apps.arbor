# Arbor

Arbor runs Squirrel, a Slack bot that uses the Claude Agent SDK to answer questions by searching Google Drive, GitHub repositories, and a curated set of web URLs. Mention `@Squirrel` in any thread and it will research your question and reply in the same thread.

## Documentation

- [Architecture Design](docs/design.md) — system design, component diagram, and technology decisions
- [How It Works](docs/operation.md) — end-to-end walkthrough of message flow, agent behavior, and admin commands
- [Social Post Approval](docs/social-posts.md) — `/propose-post` flow: modal, agentic review, Slack approval thread, manual publish, Request pull
- [AWS Setup](docs/aws-setup.md) — step-by-step procedure for provisioning all AWS infrastructure
- [Runtime Configuration](docs/configuration.md) — environment variables for Lambda and the ECS agent
- [GitHub Actions Configuration](docs/github-configuration.md) — repository secrets and variables for the Claude workflow

## Project Structure

```
packages/
  db/              # UrlStore abstraction + PostgresUrlStore (Drizzle ORM)
  lambda/          # Slack webhook receiver (AWS Lambda + API Gateway)
  agent/           # AI research agent (ECS Fargate, long-running)
  mcp-url-fetcher/ # Custom MCP server for allowlisted URL fetching
```

## Prerequisites

- Node.js 20+
- AWS account with permissions for Lambda, ECS, SQS
- PostgreSQL 14+ database accessible from Lambda and ECS
- Slack workspace with a bot app configured (Events API + slash commands)
- Anthropic API key
- Google service account with Drive API access
- GitHub personal access token

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

See [Runtime Configuration](docs/configuration.md) for the full reference. The variables that must be set before the app will start are summarised below.

**Lambda** — `SLACK_SIGNING_SECRET`, `DATABASE_URL`, `SQS_QUEUE_URL`, `ECS_CLUSTER`, `ECS_TASK_FAMILY`, `ECS_TASK_DEFINITION`, `SUBNET_IDS`, `SECURITY_GROUP_IDS`, `ADMIN_USER_IDS`

**Agent** — `ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN`, `DATABASE_URL`, `SQS_QUEUE_URL`, `AWS_REGION`, `GOOGLE_CREDENTIALS`, `GITHUB_TOKEN`

### 3. Build

```bash
npm run build
```

### 4. Deploy

Deployment is not yet automated. The recommended approach is:

1. Provision a PostgreSQL database (e.g. RDS) and create the `url_config` table — see the schema in [docs/operation.md](docs/operation.md#database-schema).
2. Package `packages/lambda/dist/` as a Lambda ZIP and deploy behind API Gateway (HTTP API).
3. Build and push the Docker image from `packages/agent/Dockerfile` to ECR.
4. Create an ECS task definition referencing that image, a Fargate service, and the SQS queue.

### 5. Configure Slack

1. Enable the **Events API** and point the Request URL to `https://<your-api-gateway>/slack/events`.
2. Subscribe to the `app_mention` bot event.
3. Add a **Slash Command** `/squirrel-admin` pointing to `https://<your-api-gateway>/slack/commands`.
4. Invite the bot to channels where you want to use it.

### 6. GitHub Actions secrets

See [GitHub Actions Configuration](docs/github-configuration.md). Required: `ANTHROPIC_API_TOKEN` and `AGENT_TOKEN` (PAT with `repo` scope).

## Development

```bash
# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

## License

MIT — see [LICENSE](LICENSE).
