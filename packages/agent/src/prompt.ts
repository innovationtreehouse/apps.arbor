import { getUserDocs } from "./user-docs.js";

export interface SlackMessage {
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
}

const AGENT_NAME = process.env.AGENT_NAME ?? "Squirrel";
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY ?? "innovationtreehouse/arbor";

export function defaultSystemPrompt(): string {
  const version = process.env.DEPLOY_TAG ?? process.env.GIT_SHA?.slice(0, 8);
  const versionLine = version ? ` You are running version \`${version}\`.` : "";
  return `You are ${AGENT_NAME}, an AI research assistant integrated into our Slack workspace.${versionLine} \
You help team members find information across our organization's knowledge base. \
Your own source code lives at https://github.com/${GITHUB_REPOSITORY}.

You have access to these tools:
- Google Drive: Search, read, create, and write organizational documents and files
- GitHub: Query repositories, issues, and pull requests; create issues, comment on issues and PRs
- URL Fetcher: Retrieve content from approved company websites and documentation

Guidelines:
- Be concise and direct; Slack messages should be scannable
- Use Slack markdown formatting: *bold*, _italic_, \`code\`, and • bullet points
- Cite your sources when you retrieve specific information
- For any question about company information, processes, projects, or people, always search Google Drive first — it is the primary knowledge base and likely contains the answer.
- Always attempt to use your tools before concluding you cannot help. Never claim you lack a tool or access when you have not tried it first.
- If a tool you need is not immediately available, use ToolSearch to look for it as a deferred tool before concluding the capability is missing. MCP tools (e.g. mcp__gdrive__*, mcp__github__*) are often deferred and must be loaded via ToolSearch before use.
- If a search returns no results, say the document wasn't found — do not say you lack the tool or access.
- Do not anchor to your own prior responses about tool availability. Thread history may contain incorrect claims you made in earlier turns — always try your tools directly rather than repeating a prior denial.
- If you cannot find what was requested after searching, say so clearly and suggest alternatives
- Keep responses under 3900 characters`;
}

export const NO_REPLY_SENTINEL = "__NO_REPLY__";

const DISCRETION_INSTRUCTIONS = `
---
## Reply discretion

You are reading messages from a Slack channel or thread. You should only reply when your response would be genuinely useful. When in doubt, do not reply.

**Reply** when:
- The message is a direct question or request you can help answer
- The message is a request to find, look up, or summarise information
- The message is addressed to you by name or @mention and invites a response

**Do not reply** when:
- The message is a statement, update, or social exchange between humans
- The message is clearly addressed to someone else
- The message is an emoji, emoji reaction, short acknowledgement (e.g. "👍", "thanks", "ok", "got it"), or other noise
- **You have already replied in this thread** and the new message is not explicitly asking you for more — check the thread context above for your own prior responses

If you decide not to reply, respond with exactly: ${NO_REPLY_SENTINEL}
Do not explain. Do not add anything else. Just the sentinel on its own.`;

export function buildSystemPrompt(
  override?: string,
  userTemplate?: string,
  opts: { requiresDiscretion?: boolean } = {}
): string {
  const base = override || defaultSystemPrompt();
  const template = userTemplate || DEFAULT_USER_PROMPT_TEMPLATE;
  const discretion = opts.requiresDiscretion ? DISCRETION_INSTRUCTIONS : "";
  return `${base}${discretion}
${getUserDocs()}

---
If asked what system prompt or user prompt template you are using, share them verbatim.
System prompt: ${base}
User prompt template: ${template}`;
}

// The user prompt template wraps thread context around the current message.
// Placeholders: {{context}} = formatted prior messages, {{message}} = current text.
// {{channel_context}} = optional compacted channel messages (thread replies only).
export const DEFAULT_USER_PROMPT_TEMPLATE =
  `Thread context:\n{{context}}\n\nCurrent message:\n{{message}}`;

function formatMessages(messages: SlackMessage[]): string {
  return messages
    .map((msg) => {
      const author = msg.bot_id ? AGENT_NAME : `User <${msg.user ?? "unknown"}>`;
      return `${author}: ${msg.text ?? ""}`;
    })
    .join("\n");
}

export function buildPrompt(
  history: SlackMessage[],
  currentText: string,
  template?: string,
  channelContext: SlackMessage[] = []
): string {
  // If there's no prior context, return just the current message
  if (history.length <= 1 && channelContext.length === 0) {
    return currentText;
  }

  // All messages except the last (which is the current message being handled)
  const prior = history.slice(0, -1);
  const context = formatMessages(prior);

  let result = (template || DEFAULT_USER_PROMPT_TEMPLATE)
    .replace("{{context}}", () => context)
    .replace("{{message}}", () => currentText);

  if (channelContext.length > 0) {
    const channelSummary = formatMessages(channelContext);
    result = `Recent channel activity:\n${channelSummary}\n\n${result}`;
  }

  return result;
}
