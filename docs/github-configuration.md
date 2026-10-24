# GitHub Actions Configuration

Two workflows use AI. `claude.yml` implements issues labeled `claude` and replies to comments on Claude's own PRs, using Claude Code. `openrouter-pr-review.yml` reviews pull requests labeled `ai-review` (see [AI pull-request review](#ai-pull-request-review)). Secrets and variables are configured at **Settings → Secrets and variables → Actions**.

---

## Secrets

| Secret | Description |
|---|---|
| `ANTHROPIC_API_TOKEN` | Anthropic API key passed to `claude-code-action` in every `claude.yml` job |
| `OPENROUTER_API_KEY` | OpenRouter key for `openrouter-pr-review.yml` (an org secret scoped to this repo works) |
| `AGENT_TOKEN` | GitHub PAT with `repo` scope. Used by Claude to read issues and PRs, create and push branches, open pull requests, and reply to PR comments. Must be a PAT (not the built-in `GITHUB_TOKEN`) so that PRs created by Claude can themselves trigger workflows |

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

The built-in `GITHUB_TOKEN` (auto-provided by Actions) needs no configuration. `openrouter-pr-review.yml` uses it to read the PR, post and edit reviews, and set the `ai-recommends-approve` label; `ci.yml` uses it for coverage artifacts and the `ai-review` label reminder; the deploy workflows use it to push images to ghcr.io and comment on merged PRs.

---

## Required PAT scopes

When creating the `AGENT_TOKEN` personal access token:

| Scope | Why |
|---|---|
| `repo` | Read issues, PRs, and code; push branches; create PRs |
| `pull_requests: write` (fine-grained) | Reply to PR comments |

---

## AI pull-request review

`openrouter-pr-review.yml` reviews pull requests with the OpenRouter AI review, using the [innovationtreehouse fork](https://github.com/innovationtreehouse/openrouter-pr-review-action) of `openrouter-pr-review-action`, pinned by commit. It is the same setup as apps.checkin.

- **Opt-in by label.** It runs only on PRs labeled `ai-review`. Applying a label needs triage access, so the public cannot spend the key. Drafts, fork PRs and Dependabot PRs are skipped. Adding the label starts a review; later pushes re-review while it stays on.
- **Trusted config.** The routing script, `.github/ai-review/instructions.md` and `.github/ai-review/profiles.json` are read from the default branch, never from the PR. A change to them takes effect after it merges. Until they are on `main`, no review runs.
- **Routing.** `.github/scripts/ai-review-route.py` asks a decision model (`DECISION_MODEL` in the workflow, now `baseten/mammoth-1:free`) which checklists in `profiles.json` apply and which reviewer runs. The ladder is NVIDIA Nemotron 3 Ultra (free), DeepSeek V4 Pro, Gemini 4 Argon, Claude Opus 5.5. A PR's first review runs on the free rung unless the fixed ladder says otherwise. Escalating to a costlier reviewer needs much more confidence. With under $5 of OpenRouter credit left, the review runs on the free rung.
- **Completeness.** After the review posts, the decision model judges whether it is complete and may rerun it once on a stronger model.
- **Context.** Every review prompt carries `instructions.md`, the matching checklists, and the PR's earlier review comments, aligned to the diff. Only comments from repo members, collaborators and the review bot are included.
- **Recommendation.** The final review shows an advisory `Recommendation:` line. Approve also applies the `ai-recommends-approve` label, which must exist in the repository. The review never submits an approval.
- **Cost.** Posted reviews show a cost word (free, less than a penny, pennies, dimes, quarters, a dollar, 2 dollars, ...), not the dollar amount. Exact figures stay in the workflow log.
- **Failure.** A run that produces no usable verdict fails the job so it can be re-run. Without `OPENROUTER_API_KEY` the route step fails with an error annotation.

### Review and approval sequence

1. Every PR carries the `ai-review` label. Add it when you open the PR or mark it ready.
2. The AI review round posts first.
3. Agent and human reviews build on its findings and reply on its threads.
4. Its recommendation is advisory. A maintainer approves.
