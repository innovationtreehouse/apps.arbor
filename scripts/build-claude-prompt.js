#!/usr/bin/env node
// Reads the current GitHub event and writes a `prompt` and `skip` output to
// GITHUB_OUTPUT.  Called as a step in the Claude CI jobs before the action runs.
'use strict';

const fs = require('fs');

const REPO       = process.env.GITHUB_REPOSITORY;     // "owner/repo"
const EVENT_NAME = process.env.GITHUB_EVENT_NAME;
const EVENT_PATH = process.env.GITHUB_EVENT_PATH;
const GH_OUTPUT  = process.env.GITHUB_OUTPUT;
const TOKEN      = process.env.GITHUB_TOKEN;
const AGENT_NAME = process.env.AGENT_NAME || 'Squirrel';
const BOT_ACTOR  = process.env.BOT_ACTOR  || '';

if (!REPO || !EVENT_NAME || !EVENT_PATH || !GH_OUTPUT || !TOKEN) {
  console.error('Missing required environment variables');
  process.exit(1);
}

const [OWNER, REPO_NAME] = REPO.split('/');

// ---------------------------------------------------------------------------
// GitHub REST helpers (uses global fetch, available in Node 18+)
// ---------------------------------------------------------------------------

const GH_HEADERS = {
  Authorization:          `Bearer ${TOKEN}`,
  Accept:                 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent':           'arbor-claude-bot',
};

async function ghGet(path, opts = {}) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO_NAME}${path}`;
  const res = await fetch(url, {
    headers: { ...GH_HEADERS, ...(opts.accept ? { Accept: opts.accept } : {}) },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}`);
  return opts.raw ? res.text() : res.json();
}

async function ghSearch(q) {
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=5`;
  const res = await fetch(url, { headers: GH_HEADERS });
  if (!res.ok) throw new Error(`GitHub Search API ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Find the PR that addresses a given issue number.
//
// Strategy:
//   1. Fast path — look for an open PR on the conventional branch
//      `claude/issue-{N}`.  This is reliable when Claude created the branch.
//   2. Fallback — search for any open PR whose body contains a closing keyword
//      ("Closes #N", "Fixes #N", "Resolves #N").  This catches cases where the
//      branch was named differently.
//
// Returns { number, branch } or null if no PR is found.
// ---------------------------------------------------------------------------

async function findPRForIssue(issueNumber) {
  // 1. Conventional branch name
  const byBranch = await ghGet(
    `/pulls?head=${OWNER}:claude%2Fissue-${issueNumber}&state=open`,
  );
  if (byBranch.length > 0) {
    return { number: byBranch[0].number, branch: byBranch[0].head.ref };
  }

  // 2. Body search — any of the GitHub closing keywords
  const q = `repo:${OWNER}/${REPO_NAME} is:pr is:open "${issueNumber}" in:body`;
  const { items } = await ghSearch(q);
  if (!items?.length) return null;

  // Filter to PRs that actually contain a recognised closing keyword
  const patterns = [
    `closes #${issueNumber}`,
    `fixes #${issueNumber}`,
    `resolves #${issueNumber}`,
  ];
  const match = items.find((item) =>
    patterns.some((p) => item.body?.toLowerCase().includes(p)),
  );
  if (!match) return null;

  // Fetch the full PR object to get the head branch name
  const pr = await ghGet(`/pulls/${match.number}`);
  return { number: pr.number, branch: pr.head.ref };
}

// ---------------------------------------------------------------------------
// GITHUB_OUTPUT writer — uses heredoc syntax to safely handle multi-line values
// ---------------------------------------------------------------------------

function writeOutput(name, value) {
  const delim = `DELIM_${name.toUpperCase()}_${Date.now()}`;
  fs.appendFileSync(GH_OUTPUT, `${name}<<${delim}\n${value}\n${delim}\n`);
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function issuePrompt(issue) {
  return `\
You are an AI coding assistant for the ${REPO_NAME} repository.
The Slack bot in this codebase is named **${AGENT_NAME}** — use this name in any user-facing strings, system prompts, or log messages you write.

A new issue has been filed:

Issue #${issue.number}: ${issue.title}
Author: ${issue.user.login}
URL: ${issue.html_url}

${issue.body?.trim() || '(no description)'}

Your task:
1. Explore the repository to understand the code relevant to the issue.
2. Implement the requested change on a new branch named \`claude/issue-${issue.number}\`
   branched off main.
3. Commit your changes with a descriptive commit message.
4. Open a pull request against the main branch titled:
     "Fix #${issue.number}: ${issue.title}"
   - Begin the PR body with "Closes #${issue.number}."
   - Include a plain-language summary of what you changed and why.

If the issue is a question or discussion rather than an actionable code change,
post a comment on the issue explaining why no PR is being created, and stop.`;
}

function issueCommentPrompt(issue, newComment, priorComments, existingPR) {
  const history = priorComments
    .filter((c) => c.id !== newComment.id)
    .map((c) => `**${c.user.login}:** ${c.body.trim()}`)
    .join('\n\n---\n\n');

  const prContext = existingPR
    ? `Your existing pull request for this issue is **PR #${existingPR.number}** on branch \`${existingPR.branch}\`.`
    : `No pull request exists yet for this issue. Create one as described above\nonce you have made the changes.`;

  return `\
You are an AI coding assistant for the ${REPO_NAME} repository.

The Slack bot in this codebase is named **${AGENT_NAME}** — use this name in any user-facing strings, system prompts, or log messages you write.

You previously opened a pull request for this issue. A follow-up comment has been posted.

Issue #${issue.number}: ${issue.title}
URL: ${issue.html_url}

Issue description:
${issue.body?.trim() || '(no description)'}

${history ? `Prior comments:\n\n${history}\n\n---\n\n` : ''}\
New comment from **${newComment.user.login}**:
${newComment.body.trim()}

${prContext}

Your task:
1. Check out the branch: \`git fetch origin && git checkout ${existingPR?.branch ?? `claude/issue-${issue.number}`}\`
2. Update the code to reflect the new feedback.
3. Commit and push the updated branch.
4. Reply to the issue confirming what you changed, or ask for clarification if
   the request is ambiguous.`;
}

function prCommentPrompt(pr, comment, filePath) {
  const location = filePath ? `on \`${filePath}\`` : 'on the pull request';

  return `\
You are an AI coding assistant for the ${REPO_NAME} repository.
The Slack bot in this codebase is named **${AGENT_NAME}** — use this name in any user-facing strings, system prompts, or log messages you write.

You previously opened this pull request and a reviewer has left a comment.

PR #${pr.number}: ${pr.title}
Branch: \`${pr.head.ref}\`
URL: ${pr.html_url}

PR description:
${pr.body?.trim() || '(no description)'}

Comment ${location} from **${comment.user.login}**:
${filePath    ? `File: ${filePath}\n` : ''}\
${comment.line ? `Line: ${comment.line}\n` : ''}\
${comment.body.trim()}

Your task:
1. Run \`git fetch origin && git checkout ${pr.head.ref}\` to restore the branch.
2. Make the code changes requested by the reviewer.
3. Commit and push the updated branch.
4. Reply to the review comment explaining what you changed, or ask a clarifying
   question if the request is unclear.`;
}

// ---------------------------------------------------------------------------
// Main routing logic
// ---------------------------------------------------------------------------

async function main() {
  const event = JSON.parse(fs.readFileSync(EVENT_PATH, 'utf8'));
  let prompt  = null;

  if (EVENT_NAME === 'issues' &&
      (event.action === 'opened' || event.action === 'labeled') &&
      event.issue.labels.some((l) => l.name === 'claude')) {
    // New issue or newly-labeled issue — propose an implementation in a PR
    prompt = issuePrompt(event.issue);

  } else if (EVENT_NAME === 'issue_comment' && event.action === 'created') {
    // Ignore bot comments to prevent loops
    const isBot = event.comment.user.type === 'Bot' ||
      (BOT_ACTOR && event.comment.user.login === BOT_ACTOR);
    if (isBot) {
      // skip
    } else if (!event.issue.pull_request) {
      // Comment on a plain issue — find the related PR and update it
      const [comments, existingPR] = await Promise.all([
        ghGet(`/issues/${event.issue.number}/comments`),
        findPRForIssue(event.issue.number),
      ]);
      prompt = issueCommentPrompt(event.issue, event.comment, comments, existingPR);
    } else {
      // Comment on a PR — only handle Claude's own PRs
      const pr = await ghGet(`/pulls/${event.issue.number}`);
      if (pr.head.ref.startsWith('claude/')) {
        prompt = prCommentPrompt(pr, event.comment, null);
      }
    }

  } else if (EVENT_NAME === 'pull_request_review_comment' && event.action === 'created') {
    // Inline review comment — only handle Claude's own PRs; ignore bot comments
    const isBot = event.comment.user.type === 'Bot' ||
      (BOT_ACTOR && event.comment.user.login === BOT_ACTOR);
    if (!isBot) {
      const pr = event.pull_request;
      if (pr.head.ref.startsWith('claude/')) {
        prompt = prCommentPrompt(pr, event.comment, event.comment.path);
      }
    }
  }

  if (!prompt) {
    writeOutput('skip', 'true');
    writeOutput('prompt', '');
    return;
  }

  writeOutput('skip', 'false');
  writeOutput('prompt', prompt);
}

main().catch((err) => {
  console.error('build-claude-prompt error:', err.message);
  process.exit(1);
});
