import { SLACK_MAX_CHARS } from "./slack.js";

const AGENT_NAME = process.env.AGENT_NAME ?? "Squirrel";

export function getUserDocs(): string {
  return `
---
## ${AGENT_NAME} User Guide

${AGENT_NAME} is an AI research assistant living in Slack. Ask it questions in any channel it belongs to, or in a direct message.

### How to interact

**In a channel:**
Just send a message — ${AGENT_NAME} will read it and respond in a thread. You can also @mention it: \`@${AGENT_NAME} find the travel policy\`.

**In a direct message (DM):**
Message ${AGENT_NAME} directly. No @mention needed.

**In a thread:**
Reply in any existing thread. ${AGENT_NAME} reads the full thread context plus recent channel messages before responding.

### What ${AGENT_NAME} can do

- **Find documents** — search Google Drive for policies, specs, reports, and other files
- **Read documents** — open and summarize any Drive file it can find
- **Search GitHub** — look up issues, pull requests, code, READMEs, and commit history in the innovationtreehouse and frc9577 organizations (read-only)
- **Research FRC questions** — Chief Delphi, The Blue Alliance, Statbotics, FIRST sites, and the Treehouse programs wiki
- **Fetch web pages** — retrieve content from an approved list of URLs (ask an admin to add URLs)

### Tips

- Be specific: *"find the 2026 travel policy"* works better than *"find the policy"*
- ${AGENT_NAME} searches Drive, GitHub, and approved URLs — it cannot browse the open web
- If it can't find something, try rephrasing or asking it to search by different terms
- Long responses are truncated at ${SLACK_MAX_CHARS.toLocaleString("en-US")} characters — ask follow-up questions for more detail

### What ${AGENT_NAME} cannot do

- Change GitHub (it can read repositories, issues and PRs, but not create or comment)
- Access channels or DMs it has not been added to
- Browse arbitrary websites (only pre-approved URLs)
- Remember information between separate conversations (each thread is independent)

### Getting help

Contact a workspace admin if you need ${AGENT_NAME} added to a channel or a new URL added to its allowlist.`;
}
