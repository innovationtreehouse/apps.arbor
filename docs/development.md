# Development Guide

This document covers local development setup, running tests, and CI.

---

## Prerequisites

- Node.js 20+
- npm

```bash
git clone <repo>
cd Squirrel
npm install        # installs all workspace packages
```

---

## Running Tests

Tests use [Vitest](https://vitest.dev/) and are co-located with source files in `__tests__/` directories.

```bash
npm test                  # run all tests once
npm run test:coverage     # run all tests with coverage report
npm run test:watch        # watch mode (if configured in your shell)
```

Coverage is written to `coverage/` and uploaded as a workflow artifact on every CI run.

### Test structure

| Package | What is tested |
|---|---|
| `packages/lambda` | Signature verification, event routing, all admin subcommands including `audit` and `audit-thread` |
| `packages/agent` | Prompt building, Slack client helpers, agent runner, event processing, MCP retry behaviour |
| `packages/db` | SQLite store implementations (in-memory) and the `createStores` factory |
| `packages/logger` | `createAuditLogger` error-swallowing wrapper |
| `packages/mcp-url-fetcher` | URL config loading, `url_list` and `url_fetch` tool handlers |

AWS SDK calls are mocked with `aws-sdk-client-mock`. Slack API calls and the Claude Agent SDK are mocked with `vi.mock()`. No network calls are made during tests.

---

## Database

### Local development (SQLite)

The `createStores` factory in `@arbor/db` selects the right store implementation based on the connection string. Any value that doesn't start with `postgres://` or `postgresql://` is treated as a SQLite file path:

```bash
# Use an in-memory database (no file, data lost on exit)
DATABASE_URL=":memory:" node packages/agent/dist/index.js

# Use a local file
DATABASE_URL="./local.db" node packages/agent/dist/index.js
```

SQLite tables (`url_config`, `agent_config`, `audit_log`) are created automatically on first connection. No migration step needed for local dev.

### Migrations (PostgreSQL)

Schema changes are managed with [Drizzle Kit](https://orm.drizzle.team/kit-docs/overview) in `packages/db`.

```bash
# Generate a new migration file from schema changes
cd packages/db
DATABASE_URL="postgres://..." npm run db:generate

# Apply pending migrations to the database
cd packages/db
DATABASE_URL="postgres://..." npm run db:migrate
```

Migration files are written to `packages/db/drizzle/`. Commit them alongside schema changes.

---

## CI Workflow

The `ci.yml` workflow runs on every pull request and on every push to `main`. It:

1. Installs dependencies (`npm ci`)
2. Runs tests with coverage (`npm run test:coverage`)
3. Uploads the coverage report as an artifact (retained for 14 days)

The Claude automation workflow (`claude.yml`) works issues labeled `claude` and replies to comments on its own PRs. Pull requests are reviewed by the OpenRouter AI review (`openrouter-pr-review.yml`) when they carry the `ai-review` label. See [github-configuration.md](github-configuration.md) for both workflows and their secrets. After editing `.github/scripts/ai-review-route.py`, run `python3 .github/scripts/ai-review-route.py route-selftest` and `scrub-selftest`; each prints `route selftest ok` or `scrub selftest ok` on success.

---

## Code Organization

```
packages/
  db/               @arbor/db — Drizzle schema, UrlStore, ConfigStore, AuditStore,
                                PostgreSQL and SQLite implementations, createStores factory
  logger/           @arbor/logger — createAuditLogger (error-swallowing audit wrapper)
  agent/            ECS container — SQS polling loop, Claude agent runner, audit logging
  lambda/           Lambda function — webhook receiver, admin commands
  mcp-url-fetcher/  Custom MCP server — URL allowlist fetcher
docs/
scripts/
  build-claude-prompt.js  — GitHub Actions helper
```

All packages are TypeScript, compiled with `tsc`. The agent package uses CommonJS output (`require.main === module`) for ECS compatibility; the MCP package uses ESM.
