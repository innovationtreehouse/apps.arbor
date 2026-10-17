# GitHub Actions Configuration

The `claude.yml` workflow automates issue implementation, and replies to comments on Claude's own PRs, using Claude Code. It requires two secrets and one optional variable, configured at **Settings → Secrets and variables → Actions**.

---

## Secrets

| Secret | Description |
|---|---|
| `ANTHROPIC_API_TOKEN` | Anthropic API key passed to `claude-code-action` in every Claude job |
| `AGENT_TOKEN` | GitHub PAT with `repo` scope. Used by Claude to read issues and PRs, create and push branches, open pull requests, and post review comments. Must be a PAT (not the built-in `GITHUB_TOKEN`) so that PRs created by Claude can themselves trigger workflows |

---

## Variables

| Variable | Default | Description |
|---|---|---|
| `AGENT_NAME` | `Squirrel` | The Slack bot's display name. Injected into every Claude prompt so that any user-facing strings or system prompt text Claude writes uses the correct name |
| `BOT_ACTOR` | _(empty)_ | GitHub login of the account associated with `AGENT_TOKEN`. When set, comments from this account are treated as bot comments and ignored to prevent reply loops. Set this to the username of your dedicated machine user |

To set a value: **Settings → Secrets and variables → Actions → Variables → New repository variable**.

---

## How the tokens are used

```
build-claude-prompt.js          claude-code-action
─────────────────────           ──────────────────
Reads issue / PR data           Makes code changes
via GitHub REST API   ←──────── Replies to PR comments
                                Creates PRs
         ↑                           ↑
   AGENT_TOKEN                 AGENT_TOKEN
                          ANTHROPIC_API_TOKEN
```

The built-in `GITHUB_TOKEN` (auto-provided by Actions) is used only in `ci.yml` for uploading coverage artifacts — no configuration required.

---

## Required PAT scopes

When creating the `AGENT_TOKEN` personal access token:

| Scope | Why |
|---|---|
| `repo` | Read issues, PRs, and code; push branches; create PRs |
| `pull_requests: write` (fine-grained) | Reply to PR comments |

---

## AI pull-request review

`openrouter-pr-review.yml` reviews pull requests with the OpenRouter AI review. It is separate from `claude.yml`.

- **Opt-in by label.** It runs only on PRs labeled `ai-review`. Applying a label needs triage access, so the public cannot trigger it. Every PR should carry the label; add it when you open the PR or mark it ready.
- **Routing.** `.github/scripts/ai-review-route.py` asks TypeSafe Jev 1.14 which review checklists in `.github/ai-review/profiles.json` apply and which reviewer runs, from a fixed ladder: NVIDIA Nemotron Super VL (free), GLM-5.3, Gemini 4 Argon, Claude Opus 5.5. Escalating to a costlier reviewer needs much more confidence. After the review posts, Jev judges whether it was complete and may rerun it once on a stronger model.
- **Context.** Every review prompt carries `.github/ai-review/instructions.md` and the PR's earlier review comments, aligned to the diff.
- **Recommendation.** The final review shows an advisory `Recommendation:` line; approve also applies the `ai-recommends-approve` label. A maintainer approves.
- **Cost.** Posted reviews show a cost word (free, less than a penny, pennies, dimes, quarters, a dollar, 2 dollars, ...), not the dollar amount.
- **Secret.** `OPENROUTER_API_KEY` (an org secret scoped to this repo works). Without it the review is skipped with an error annotation.

