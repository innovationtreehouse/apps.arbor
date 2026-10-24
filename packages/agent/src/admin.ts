import type { UrlStore, ConfigStore, AuditStore, AuditRecord } from "@arbor/db";
import { buildSystemPrompt, defaultSystemPrompt, DEFAULT_USER_PROMPT_TEMPLATE } from "./prompt.js";
import { DEFAULT_MODEL, openRouterBaseUrl } from "./provider.js";

export interface AdminCommand {
  type: "admin_command";
  subcommand: string;
  args: string[];
  userId: string;
  responseUrl: string;
}

interface Stores {
  urlStore: UrlStore;
  configStore: ConfigStore;
  auditStore: AuditStore;
}

const MAX_URL_COUNT = parseInt(process.env.MAX_URL_COUNT ?? "100", 10);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function processAdminCommand(cmd: AdminCommand, stores: Stores): Promise<void> {
  const { subcommand, args, userId, responseUrl } = cmd;
  const { urlStore, configStore, auditStore } = stores;

  let text: string;
  try {
    switch (subcommand) {
      case "list":
        text = await handleList(urlStore);
        break;
      case "add":
        text = await handleAdd(args, userId, urlStore);
        break;
      case "remove":
        text = await handleRemove(args, urlStore);
        break;
      case "test":
        text = await handleTest(args);
        break;
      case "model":
        text = await handleModel(args, configStore);
        break;
      case "audit":
        text = await handleAudit(args, auditStore);
        break;
      case "audit-thread":
        text = await handleAuditThread(args, auditStore);
        break;
      case "token-limit":
        text = await handleTokenLimit(args, configStore);
        break;
      case "check":
        text = await handleCheck(urlStore);
        break;
      case "prompt":
        text = await handlePrompt(args, configStore);
        break;
      case "channel-messages":
        text = await handleChannelMessages(args, configStore);
        break;
      case "version":
        text = handleVersion();
        break;
      default:
        text = `Unknown subcommand: \`${subcommand}\`. Try \`/squirrel-admin help\`.`;
    }
  } catch (err) {
    text = `❌ Command failed: ${errorMessage(err)}`;
  }

  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", text }),
    signal: AbortSignal.timeout(9_000),
  });
}

async function handleList(urlStore: UrlStore): Promise<string> {
  const items = await urlStore.listAll();
  if (items.length === 0) {
    return "No URLs configured. Use `/squirrel-admin add <url> <description>` to add one.";
  }
  const lines = items.map(
    (item) =>
      `• ${item.enabled ? "✅" : "❌"} *${item.url}*\n  ${item.description} _(added by <@${item.added_by}>)_`
  );
  return "*Configured URLs:*\n" + lines.join("\n");
}

async function handleAdd(args: string[], userId: string, urlStore: UrlStore): Promise<string> {
  if (args.length < 2) return "Usage: `/squirrel-admin add <url> <description>`";
  const rawUrl = args[0];
  const description = args.slice(1).join(" ");
  if (!rawUrl.startsWith("https://")) return "URLs must start with `https://`.";
  const currentCount = await urlStore.count();
  if (currentCount >= MAX_URL_COUNT) {
    return `Cannot add more URLs — limit of ${MAX_URL_COUNT} reached.`;
  }
  // Always store as a wildcard prefix so all pages under the URL are accessible.
  const url = rawUrl.endsWith("*") ? rawUrl : `${rawUrl}*`;
  await urlStore.upsert({ url, description, added_by: userId, enabled: true });
  return `✅ Added: *${url}*\n${description}`;
}

async function handleRemove(args: string[], urlStore: UrlStore): Promise<string> {
  if (args.length < 1) return "Usage: `/squirrel-admin remove <url>`";
  await urlStore.delete(args[0]);
  return `✅ Removed: *${args[0]}*`;
}

async function handleTest(args: string[]): Promise<string> {
  if (args.length < 1) return "Usage: `/squirrel-admin test <url>`";
  const url = args[0];
  if (!url.startsWith("https://")) return "URLs must start with `https://`.";
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Squirrel-Bot/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return `❌ Fetch failed: HTTP ${response.status} ${response.statusText}`;
    }
    const text = await response.text();
    const preview = text.slice(0, 500).trim();
    return `✅ *${url}* is reachable (HTTP ${response.status})\n\n*Content preview:*\n\`\`\`\n${preview}\n\`\`\``;
  } catch (err: unknown) {
    return `❌ Fetch failed: ${errorMessage(err)}`;
  }
}

async function handleModel(args: string[], configStore: ConfigStore): Promise<string> {
  if (args.length === 0) {
    const current = await configStore.get("model");
    const display = current ?? `${process.env.MODEL ?? DEFAULT_MODEL} (default)`;
    // Pre-OpenRouter values (e.g. "claude-opus-4-6") lack the provider prefix and will fail.
    const warn = display.includes("/") ? "" : "\n⚠️ Not an OpenRouter model ID (expected `provider/model`). Run `/squirrel-admin model anthropic/claude-opus-4.6`.";
    return `*Active model:* \`${display}\`${warn}`;
  }
  if (!args[0].includes("/")) {
    return `❌ \`${args[0]}\` is not an OpenRouter model ID. Use \`provider/model\`, e.g. \`${DEFAULT_MODEL}\`.`;
  }
  await configStore.set("model", args[0]);
  return `✅ Model set to \`${args[0]}\`. Takes effect on the next message.`;
}

function auditLine(r: AuditRecord, where = ""): string {
  const ts = new Date(r.created_at).toISOString().replace("T", " ").slice(0, 19);
  return `• \`${ts}\` <@${r.user_id}>${where} (${r.duration_ms}ms, ${r.model ?? "default"})`;
}

function clip(text: string, max: number): string {
  return text.slice(0, max).replace(/\n/g, " ") + (text.length > max ? "…" : "");
}

async function handleAudit(args: string[], auditStore: AuditStore): Promise<string> {
  const limit = Math.min(parseInt(args[0] ?? "10", 10) || 10, 50);
  const records = await auditStore.listRecent(limit);
  if (records.length === 0) return "No audit records found.";
  const lines = records.map((r) => `${auditLine(r, ` in <#${r.channel}>`)}\n  _${clip(r.prompt, 80)}_`);
  return `*Recent interactions (${records.length}):*\n${lines.join("\n")}`;
}

async function handleAuditThread(args: string[], auditStore: AuditStore): Promise<string> {
  if (args.length < 2) return "Usage: `/squirrel-admin audit-thread <channel> <thread_ts>`";
  const [channel, thread_ts] = args;
  const records = await auditStore.listByThread(channel, thread_ts);
  if (records.length === 0) return "No audit records found for that thread.";
  const lines = records.map((r) =>
    `${auditLine(r)}\n  *Prompt:* ${clip(r.prompt, 120)}\n  *Response:* ${clip(r.response, 120)}`);
  return `*Thread interactions (${records.length}):*\n${lines.join("\n")}`;
}

async function handleTokenLimit(args: string[], configStore: ConfigStore): Promise<string> {
  const [target = "default", limitArg] = args;
  const key = target === "default" ? "token_limit:default" : `token_limit:${target}`;
  const label = target === "default" ? "default" : `<#${target}>`;
  if (limitArg !== undefined) {
    const n = parseInt(limitArg, 10);
    if (isNaN(n) || n <= 0) return "Token limit must be a positive integer.";
    await configStore.set(key, String(n));
    return `✅ Token limit for ${label} set to *${n}*.`;
  }
  const current = await configStore.get(key);
  if (current === undefined) return `No token limit set for ${label} (unlimited).`;
  return `Token limit for ${label}: *${current}* tokens per request.`;
}

async function handleCheck(urlStore: UrlStore): Promise<string> {
  const results = await Promise.all([checkGoogleDrive(), checkGitHub(), checkOpenRouter(), checkUrlFetcher(urlStore)]);
  return `*Data source health check:*\n${results.join("\n")}`;
}

async function checkGitHub(): Promise<string> {
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) return "❌ *GitHub*: `GITHUB_TOKEN` not set";
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${githubToken}`, "User-Agent": "Squirrel-Bot/1.0" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return `❌ *GitHub*: API returned HTTP ${res.status}`;
    const user = await res.json() as { login?: string };
    return `✅ *GitHub*: authenticated as \`${user.login ?? "unknown"}\``;
  } catch (err) {
    return `❌ *GitHub*: ${errorMessage(err)}`;
  }
}

function checkOpenRouter(): string {
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const baseUrl = openRouterBaseUrl();
  if (!openRouterKey) return "❌ *OpenRouter*: `OPENROUTER_API_KEY` not set";
  if (!openRouterKey.startsWith("sk-or-")) {
    return `⚠️ *OpenRouter*: key set but format looks unexpected (\`${baseUrl}\`)`;
  }
  return `✅ *OpenRouter*: key configured (\`${openRouterKey.slice(0, 12)}…\`) via \`${baseUrl}\``;
}

async function checkUrlFetcher(urlStore: UrlStore): Promise<string> {
  try {
    const count = await urlStore.count();
    return `✅ *URL fetcher*: database reachable, ${count} URL${count === 1 ? "" : "s"} configured`;
  } catch (err) {
    return `❌ *URL fetcher*: database error — ${errorMessage(err)}`;
  }
}

const PROMPT_TARGETS = ["system", "user"] as const;
type PromptTarget = (typeof PROMPT_TARGETS)[number];

function promptKey(target: PromptTarget): string {
  return `prompt:${target}`;
}

function promptDefault(target: PromptTarget): string {
  return target === "system" ? defaultSystemPrompt() : DEFAULT_USER_PROMPT_TEMPLATE;
}

function promptLabel(target: PromptTarget): string {
  return target === "system" ? "System prompt" : "User prompt template";
}

async function handlePrompt(args: string[], configStore: ConfigStore): Promise<string> {
  const [subcmd, ...rest] = args;

  if (!subcmd || subcmd === "show") {
    // show [system|user] — default shows both
    const targets: PromptTarget[] = rest[0] === "system" ? ["system"]
      : rest[0] === "user" ? ["user"]
      : ["system", "user"];

    const parts: string[] = [];
    for (const target of targets) {
      const override = await configStore.get(promptKey(target));
      const active = override || promptDefault(target);
      const source = override ? "custom override" : "default (from code)";
      const preview = active.length > 1500 ? active.slice(0, 1500) + "…" : active;
      parts.push(`*${promptLabel(target)} (${source}):*\n\`\`\`\n${preview}\n\`\`\``);
    }
    return parts.join("\n\n");
  }

  if (subcmd === "set") {
    const [target, ...textParts] = rest;
    if (!PROMPT_TARGETS.includes(target as PromptTarget) || textParts.length === 0) {
      return "Usage: `/squirrel-admin prompt set system|user <text>`";
    }
    const newPrompt = textParts.join(" ");
    await configStore.set(promptKey(target as PromptTarget), newPrompt);
    const preview = newPrompt.length > 500 ? newPrompt.slice(0, 500) + "…" : newPrompt;
    return `✅ ${promptLabel(target as PromptTarget)} updated. Takes effect on the next message.\n\`\`\`\n${preview}\n\`\`\``;
  }

  if (subcmd === "reset") {
    const [target] = rest;
    if (target && !PROMPT_TARGETS.includes(target as PromptTarget)) {
      return `Unknown prompt target: \`${target}\`. Use \`system\` or \`user\`.`;
    }
    const targets: PromptTarget[] = target ? [target as PromptTarget] : ["system", "user"];
    for (const t of targets) {
      await configStore.set(promptKey(t), "");
    }
    const resetList = targets.map((t) => `*${promptLabel(t)}:*\n\`\`\`\n${promptDefault(t)}\n\`\`\``).join("\n\n");
    return `✅ ${targets.length === 1 ? promptLabel(targets[0]) : "Both prompts"} reset to default. Takes effect on the next message.\n\n${resetList}`;
  }

  return `Unknown prompt subcommand: \`${subcmd}\`. Available: \`show [system|user]\`, \`set system|user <text>\`, \`reset [system|user]\`.`;
}

function handleVersion(): string {
  const sha = process.env.GIT_SHA;
  const tag = process.env.DEPLOY_TAG;
  const diffUrl = process.env.DEPLOY_DIFF_URL;

  if (!sha) {
    return "Version information is not available (env not set at deployment time).";
  }

  const lines = [
    `*Version:* \`${tag ?? sha.slice(0, 8)}\``,
    `*Commit:* \`${sha}\``,
  ];
  if (diffUrl) {
    lines.push(`*Changes since last promotion:* ${diffUrl}`);
  }
  return lines.join("\n");
}

async function handleChannelMessages(args: string[], configStore: ConfigStore): Promise<string> {
  const [setting] = args;
  if (!setting) {
    const current = await configStore.get("channel_messages");
    const status = current === "on" ? "✅ *on*" : "❌ *off* (default)";
    return `*Channel message responses:* ${status}\nUse \`/squirrel-admin channel-messages on|off\` to change.`;
  }
  if (setting !== "on" && setting !== "off") {
    return "Usage: `/squirrel-admin channel-messages on|off`";
  }
  await configStore.set("channel_messages", setting);
  const emoji = setting === "on" ? "✅" : "❌";
  const detail = setting === "on"
    ? "The bot will now respond to all channel messages and thread replies (with discretion)."
    : "The bot will only respond to @mentions and DMs.";
  return `${emoji} Channel message responses turned *${setting}*. ${detail}`;
}

async function checkGoogleDrive(): Promise<string> {
  const googleCreds = process.env.GOOGLE_CREDENTIALS;
  if (!googleCreds) return "❌ *Google Drive*: `GOOGLE_CREDENTIALS` not set";
  let creds: { client_email: string; private_key: string; project_id: string };
  try {
    creds = JSON.parse(googleCreds);
  } catch {
    return "❌ *Google Drive*: `GOOGLE_CREDENTIALS` is not valid JSON";
  }
  const missing = ["client_email", "private_key", "project_id"].filter((f) => !creds?.[f as keyof typeof creds]);
  if (missing.length > 0) return `❌ *Google Drive*: credentials JSON missing fields: ${missing.join(", ")}`;

  try {
    // Build a JWT to obtain an access token for the Drive API
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: creds.client_email,
      scope: "https://www.googleapis.com/auth/drive",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    })).toString("base64url");

    const { createSign } = await import("crypto");
    const sign = createSign("RSA-SHA256");
    sign.update(`${header}.${payload}`);
    const signature = sign.sign(creds.private_key, "base64url");
    const jwt = `${header}.${payload}.${signature}`;

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      return `❌ *Google Drive*: auth failed (${tokenRes.status}) — ${body.slice(0, 120)}`;
    }

    const { access_token } = await tokenRes.json() as { access_token: string };

    const headers = { Authorization: `Bearer ${access_token}` };
    const timeout = { signal: AbortSignal.timeout(8_000) };

    // List up to 10 files visible to the service account (all drives).
    const [fileRes, drivesRes] = await Promise.all([
      fetch(
        "https://www.googleapis.com/drive/v3/files?pageSize=10&fields=files(id,name)&includeItemsFromAllDrives=true&supportsAllDrives=true&corpora=allDrives",
        { headers, ...timeout }
      ),
      // drives.list returns Shared Drives the service account is a member of.
      fetch(
        "https://www.googleapis.com/drive/v3/drives?pageSize=20&fields=drives(id,name)",
        { headers, ...timeout }
      ),
    ]);

    if (!fileRes.ok) {
      return `❌ *Google Drive*: authenticated but files.list returned HTTP ${fileRes.status}`;
    }

    const { files } = await fileRes.json() as { files: { id: string; name: string }[] };

    const lines: string[] = [
      `✅ *Google Drive*: authenticated as \`${creds.client_email}\``,
    ];

    if (files.length === 0) {
      lines.push("  • No files visible (share files or folders directly with the service account email)");
    } else {
      lines.push(`  • ${files.length} file${files.length === 1 ? "" : "s"} visible`);
    }

    if (drivesRes.ok) {
      const { drives } = await drivesRes.json() as { drives: { id: string; name: string }[] };
      if (drives.length === 0) {
        lines.push("  • No Shared Drive memberships (to grant access: open the Shared Drive → Manage members → add the service account email)");
      } else {
        lines.push(`  • Member of ${drives.length} Shared Drive${drives.length === 1 ? "" : "s"}: ${drives.map((d) => `_${d.name}_`).join(", ")}`);
      }
    }

    return lines.join("\n");
  } catch (err) {
    return `❌ *Google Drive*: ${errorMessage(err)}`;
  }
}
