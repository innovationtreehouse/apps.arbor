import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UrlConfig } from "@arbor/mcp-url-fetcher";
import { makePlan, type Plan } from "../plan.js";

const mcp = vi.hoisted(() => ({ callTool: vi.fn(), connect: vi.fn(), close: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(function () { return mcp; }),
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

const { web } = await import("../sources/web.js");
const { chiefdelphi } = await import("../sources/chiefdelphi.js");
const { tba } = await import("../sources/tba.js");
const { statbotics } = await import("../sources/statbotics.js");
const { programs, WAKE_DELAYS_MS } = await import("../sources/programs.js");
const { drive, driveStatus, resetDriveStatus } = await import("../sources/drive.js");
const { slack } = await import("../sources/slack.js");
const { github } = await import("../sources/github.js");
const { NotConfigured, htmlToText } = await import("../sources/http.js");

const allowAll = { urls: { isAllowed: () => true } as unknown as UrlConfig };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html" } });
// Route mocked fetch calls by URL substring; unmatched URLs are a test bug.
function route(routes: Record<string, () => Response>) {
  const fn = vi.fn(async (url: string | URL) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (!key) throw new Error(`unexpected fetch ${url}`);
    return routes[key]();
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

let plan: Plan;
const env = { ...process.env };
beforeEach(() => {
  plan = makePlan("How did FRC team 9577 do with swerve in 2026?");
  for (const k of ["TBA_AUTH_KEY", "SLACK_USER_TOKEN", "SLACK_BOT_TOKEN", "GITHUB_TOKEN", "GDRIVE_MCP_PROXY_URL"]) delete process.env[k];
  resetDriveStatus();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.env = { ...env };
});

describe("htmlToText", () => {
  it("drops scripts and tags and decodes entities once", () => {
    expect(htmlToText("<script>x()</script><p>a &amp;lt; b&nbsp;c</p>")).toBe("a &lt; b c");
  });
});

describe("web source", () => {
  it("returns page text, a PDF link card, and notes per-URL failures", async () => {
    plan.urls = ["https://www.firstinspires.org/", "https://firstfrc.blob.core.windows.net/m.pdf", "https://docs.wpilib.org/x"];
    route({
      "firstinspires": () => html("<title>FIRST</title><p>Programs</p>"),
      "m.pdf": () => new Response("%PDF", { headers: { "content-type": "application/pdf" } }),
      "wpilib": () => html("gone", 404),
    });
    const { docs, note } = await web(plan, allowAll);
    expect(docs).toEqual([
      { source: "web", url: "https://www.firstinspires.org/", title: "FIRST", text: "FIRST Programs" },
      expect.objectContaining({ title: "m.pdf", link: true }),
    ]);
    expect(note).toContain("HTTP 404");
  });

  it("fails when every URL fails, including non-allowlisted ones", async () => {
    plan.urls = ["https://evil.com/"];
    vi.stubGlobal("fetch", vi.fn());
    await expect(web(plan, { urls: { isAllowed: () => false } as unknown as UrlConfig })).rejects.toThrow("not on allowlist");
  });

  it("rejects binary content types", async () => {
    plan.urls = ["https://www.firstinspires.org/x"];
    route({ "firstinspires": () => new Response("x", { headers: { "content-type": "image/png" } }) });
    await expect(web(plan, allowAll)).rejects.toThrow("unsupported content type");
  });
});

describe("chiefdelphi source", () => {
  it("searches Discourse JSON and reads topic posts", async () => {
    const fetchMock = route({
      "search.json": () => json({ topics: [{ id: 7, title: "Swerve tips", slug: "swerve-tips" }] }),
      "/t/7.json": () => json({ post_stream: { posts: [{ username: "a", cooked: "<p>Use MK4i</p>" }] } }),
    });
    const { docs } = await chiefdelphi(plan, allowAll);
    expect(docs).toEqual([{ source: "chiefdelphi", url: "https://www.chiefdelphi.com/t/swerve-tips/7", title: "Swerve tips", text: "a: Use MK4i" }]);
    expect(String(fetchMock.mock.calls[0][0])).toContain(`q=${encodeURIComponent(plan.query)}`);
  });

  it("handles no topics", async () => {
    route({ "search.json": () => json({ posts: [] }) });
    expect((await chiefdelphi(plan, allowAll)).docs).toEqual([]);
  });
});

describe("http get", () => {
  it("does not follow redirects for keyed requests", async () => {
    const fetchMock = route({ "thebluealliance": () => new Response("", { status: 301, headers: { location: "https://evil.com/" } }) });
    process.env.TBA_AUTH_KEY = "k";
    await expect(tba(plan, allowAll)).rejects.toThrow("HTTP 301");
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe("manual");
  });
});

describe("tba source", () => {
  it("is not configured without TBA_AUTH_KEY", async () => {
    await expect(tba(plan, allowAll)).rejects.toBeInstanceOf(NotConfigured);
  });

  it("sends the key header and returns one team card", async () => {
    process.env.TBA_AUTH_KEY = "tba-secret";
    const fetchMock = route({
      "/team/frc9577/events/2026/statuses": () => json({ "2026mnmi": { overall_status_str: "Rank 3" } }),
      "/team/frc9577": () => json({ nickname: "Recoil" }),
    });
    const { docs } = await tba(plan, allowAll);
    expect(docs[0].text).toContain("Recoil");
    expect(docs[0].text).toContain("Rank 3");
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ "X-TBA-Auth-Key": "tba-secret" });
  });

  it("returns nothing without a team number", async () => {
    process.env.TBA_AUTH_KEY = "k";
    expect((await tba(makePlan("swerve gearing"), allowAll)).docs).toEqual([]);
  });
});

describe("statbotics source", () => {
  it("returns the team-year card", async () => {
    route({ "team_year/9577/2026": () => json({ epa: { total_points: { mean: 40 } } }) });
    expect((await statbotics(plan, allowAll)).docs[0].url).toBe("https://www.statbotics.io/team/9577");
  });

  it("notes an empty response and skips without a team", async () => {
    route({ "team_year": () => json({}) });
    expect(await statbotics(plan, allowAll)).toEqual({ docs: [], note: "no data for team 9577 in 2026" });
    expect((await statbotics(makePlan("swerve"), allowAll)).docs).toEqual([]);
  });

  it("throws on HTTP errors", async () => {
    route({ "team_year": () => json({}, 500) });
    await expect(statbotics(plan, allowAll)).rejects.toThrow("HTTP 500 from api.statbotics.io");
  });
});

describe("programs source", () => {
  it("retries 503 while the wiki wakes, then returns the page", async () => {
    vi.useFakeTimers();
    let calls = 0;
    route({ "programs.innovationtreehouse.org": () => (++calls < 3 ? html("wiki is starting", 503) : html("<title>Programs</title>FLL")) });
    const result = programs(plan, allowAll);
    await vi.advanceTimersByTimeAsync(WAKE_DELAYS_MS[0] + WAKE_DELAYS_MS[1]);
    expect((await result).docs[0]).toMatchObject({ title: "Programs", text: "Programs FLL" });
    expect(calls).toBe(3);
  });

  it("reports the wiki was waking after the last retry", async () => {
    vi.useFakeTimers();
    const fetchMock = route({ "programs": () => html("wiki is starting", 503) });
    const result = programs(plan, allowAll);
    const assertion = expect(result).rejects.toThrow("the wiki was waking");
    await vi.advanceTimersByTimeAsync(WAKE_DELAYS_MS.reduce((a, b) => a + b));
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(WAKE_DELAYS_MS.length + 1);
  });

  it("stops waiting and reports waking when the research budget aborts", async () => {
    route({ "programs": () => html("wiki is starting", 503) });
    const controller = new AbortController();
    const result = programs(plan, { ...allowAll, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(result).rejects.toThrow("the wiki was waking");
  });

  it("fails fast on other errors", async () => {
    route({ "programs": () => html("no", 403) });
    await expect(programs(plan, allowAll)).rejects.toThrow("HTTP 403");
  });
});

describe("drive source", () => {
  // Braces matter: a function returned from beforeEach becomes a cleanup hook.
  beforeEach(() => { mcp.callTool.mockReset(); });

  it("is not configured without the proxy URL", async () => {
    expect(await driveStatus()).toBe("not configured");
    await expect(drive(plan, allowAll)).rejects.toBeInstanceOf(NotConfigured);
  });

  it("reports Drive unavailable when the proxy is unhealthy", async () => {
    process.env.GDRIVE_MCP_PROXY_URL = "http://127.0.0.1:8123/mcp";
    route({ "/health": () => new Response("starting", { status: 503 }) });
    await expect(drive(plan, allowAll)).rejects.toThrow("Drive unavailable");
  });

  it("searches, reads Google Docs, and returns other files as link cards", async () => {
    process.env.GDRIVE_MCP_PROXY_URL = "http://127.0.0.1:8123/mcp";
    route({ "/health": () => new Response("ok") });
    mcp.callTool.mockImplementation(async (req: { name: string }) => { return req.name === "searchDriveFiles"
      ? { content: [{ type: "text", text: JSON.stringify({ files: [
        { id: "d1", name: "Handbook", mimeType: "application/vnd.google-apps.document", url: "https://docs.google.com/d1" },
        { id: "s1", name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet", url: "https://docs.google.com/s1" },
      ] }) }] }
      : { content: [{ type: "text", text: "Handbook text" }] }; });
    const { docs } = await drive(plan, allowAll);
    expect(docs).toEqual([
      { source: "drive", url: "https://docs.google.com/d1", title: "Handbook", text: "Handbook text" },
      expect.objectContaining({ title: "Budget", link: true }),
    ]);
    expect(mcp.callTool).toHaveBeenCalledWith({ name: "readDocument", arguments: { documentId: "d1", maxLength: 12_000 } }, undefined, { signal: undefined });
    expect(mcp.close).toHaveBeenCalled();
  });
});

describe("slack source", () => {
  it("uses search.messages with a user token and keeps public channels only", async () => {
    process.env.SLACK_USER_TOKEN = "xoxp-user";
    const fetchMock = route({ "search.messages": () => json({ ok: true, messages: { matches: [
      { text: "swerve notes", ts: "1", permalink: "https://s/p1", username: "amy", channel: { name: "build" } },
      { text: "secret swerve", ts: "2", permalink: "https://s/p2", channel: { name: "private", is_private: true } },
      { text: "dm swerve", ts: "3", permalink: "https://s/p3", channel: { is_im: true } },
    ] } }) });
    const { docs } = await slack(plan, allowAll);
    expect(docs).toEqual([{ source: "slack", url: "https://s/p1", title: "Slack message in #build by amy", text: "swerve notes" }]);
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer xoxp-user" });
  });

  it("scans joined public channels with the bot token when there is no user token", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-bot";
    route({
      "users.conversations": () => json({ ok: true, channels: [{ id: "C1", name: "build" }] }),
      "conversations.history": () => json({ ok: true, messages: [
        { text: "swerve module for team 9577 is done", ts: "1.1", user: "U1" },
        { text: "lunch", ts: "1.2" },
        { text: plan.question, ts: "1.3" },
      ] }),
      "chat.getPermalink": () => json({ ok: true, permalink: "https://s/p1" }),
    });
    const { docs, note } = await slack(plan, allowAll);
    expect(docs).toEqual([{ source: "slack", url: "https://s/p1", title: "Slack message in #build by U1", text: "swerve module for team 9577 is done" }]);
    expect(note).toContain("SLACK_USER_TOKEN not set");
  });

  it("surfaces Slack API errors and is not configured without any token", async () => {
    await expect(slack(plan, allowAll)).rejects.toBeInstanceOf(NotConfigured);
    process.env.SLACK_USER_TOKEN = "xoxp-user";
    route({ "search.messages": () => json({ ok: false, error: "missing_scope" }) });
    await expect(slack(plan, allowAll)).rejects.toThrow("Slack search.messages: missing_scope");
  });
});

describe("github source", () => {
  it("is not configured without GITHUB_TOKEN", async () => {
    await expect(github(plan, allowAll)).rejects.toBeInstanceOf(NotConfigured);
  });

  it("searches issues, code and repos in both orgs and reads the README", async () => {
    process.env.GITHUB_TOKEN = "ghp_x";
    const fetchMock = route({
      "search/issues": () => json({ items: [{ title: "Swerve drift", html_url: "https://gh/i/1", body: "drifts", pull_request: {} }] }),
      "search/code": () => json({ items: [{ path: "src/Swerve.java", html_url: "https://gh/c", repository: { full_name: "frc9577/robot" }, text_matches: [{ fragment: "class Swerve" }] }] }),
      "search/repositories": () => json({ items: [{ full_name: "frc9577/robot", html_url: "https://gh/r" }] }),
      "/readme": () => new Response("# Robot"),
    });
    const { docs } = await github(plan, allowAll);
    expect(docs.map((d) => d.title)).toEqual(["PR: Swerve drift", "frc9577/robot/src/Swerve.java", "frc9577/robot README"]);
    expect(docs[1].text).toBe("class Swerve");
    expect(docs[2].text).toBe("# Robot");
    expect(decodeURIComponent(String(fetchMock.mock.calls[0][0]))).toContain("org:innovationtreehouse org:frc9577");
  });

  it("keeps going when a README cannot be read", async () => {
    process.env.GITHUB_TOKEN = "ghp_x";
    route({
      "search/issues": () => json({ items: [] }),
      "search/code": () => json({ items: [] }),
      "search/repositories": () => json({ items: [{ full_name: "o/r", html_url: "https://gh/r" }] }),
      "/readme": () => new Response("nope", { status: 404 }),
    });
    expect((await github(plan, allowAll)).docs[0].text).toBe("");
  });
});
