import type { Doc, Source } from "../plan.js";
import { NotConfigured, get, getJson } from "./http.js";

export const GITHUB_ORGS = ["innovationtreehouse", "frc9577"];
const GH = "https://api.github.com";

interface Issue { title: string; html_url: string; body?: string | null; pull_request?: unknown }
interface Code { path: string; html_url: string; repository: { full_name: string }; text_matches?: { fragment: string }[] }
interface Repo { full_name: string; html_url: string }

// Issues/PRs, code and the best-matching repo README, scoped to both orgs with org: qualifiers.
export const github: Source = async (plan, { signal }) => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new NotConfigured("GITHUB_TOKEN not set");
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.text-match+json" };
  const q = encodeURIComponent(`${plan.terms.slice(0, 3).join(" ")} ${GITHUB_ORGS.map((o) => `org:${o}`).join(" ")}`);
  const [issues, code, repos] = await Promise.all([
    getJson<{ items: Issue[] }>(`${GH}/search/issues?q=${q}&per_page=2`, headers, signal),
    getJson<{ items: Code[] }>(`${GH}/search/code?q=${q}&per_page=1`, headers, signal),
    getJson<{ items: Repo[] }>(`${GH}/search/repositories?q=${q}&per_page=1`, headers, signal),
  ]);
  const readmes = await Promise.all(repos.items.map(async (r): Promise<Doc> => ({
    source: "github",
    url: r.html_url,
    title: `${r.full_name} README`,
    text: await get(`${GH}/repos/${r.full_name}/readme`, { ...headers, Accept: "application/vnd.github.raw" }, signal)
      .then((res) => res.text(), () => ""),
  })));
  return {
    docs: [
      ...issues.items.map((i) => ({ source: "github", url: i.html_url, title: `${i.pull_request ? "PR" : "Issue"}: ${i.title}`, text: i.body ?? "" })),
      ...code.items.map((c) => ({ source: "github", url: c.html_url, title: `${c.repository.full_name}/${c.path}`,
        text: (c.text_matches ?? []).map((m) => m.fragment).join("\n...\n") })),
      ...readmes,
    ],
  };
};
