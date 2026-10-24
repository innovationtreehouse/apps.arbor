import type { UrlEntry } from "@arbor/db";
import type { UrlConfig } from "@arbor/mcp-url-fetcher";

export interface Plan {
  question: string;
  terms: string[];
  query: string; // first few terms, for AND-style search APIs
  team?: number;
  year: number;
  urls: string[]; // allowlisted pages to fetch directly
  sources: string[]; // keys of SOURCES in fetch.ts
}

// One fetched document. `link` documents (PDFs, non-Doc Drive files) skip condensing.
export interface Doc { source: string; url: string; title: string; text: string; link?: boolean }

export type Source = (plan: Plan, deps: { urls: UrlConfig }) => Promise<{ docs: Doc[]; note?: string }>;

const STOP = new Set(("about any are can could did does for from have how into its know let me our please " +
  "show should tell than that the their them there these they this was what when where which who why will " +
  "with would you your find need want get").split(" "));

// Hosts with their own source; fetching their front page adds nothing.
const DEDICATED = /chiefdelphi\.com|thebluealliance\.com|statbotics\.io|programs\.innovationtreehouse\.org/;

// ponytail: keyword planner, no model call. Allowlist pages are ranked by how many
// terms their description shares; swap in a model-written plan if this misses too often.
export function makePlan(question: string, allowlist: UrlEntry[] = []): Plan {
  const linked = question.match(/https:\/\/[^\s|>]+/g) ?? [];
  const words = question.replace(/<[^>]*>/g, " ").toLowerCase().match(/[a-z0-9][a-z0-9+-]*/g) ?? [];
  const terms = [...new Set(words)].filter((w) => w.length > 2 && !STOP.has(w)).slice(0, 8);
  const team = Number(question.match(/\b(?:team|frc)\s*#?\s*(\d{1,5})\b/i)?.[1]) || undefined;
  const year = Number(question.match(/\b(20\d\d)\b/)?.[1]) || new Date().getFullYear();
  const matched = allowlist
    .filter((e) => !DEDICATED.test(e.url))
    .map((e) => ({ url: e.url.replace(/\*$/, ""), hits: terms.filter((t) => e.description.toLowerCase().includes(t)).length }))
    .filter((e) => e.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .map((e) => e.url);
  const urls = [...new Set([...linked, ...matched])].slice(0, 3);
  return {
    question,
    terms,
    query: terms.slice(0, 4).join(" "),
    team,
    year,
    urls,
    sources: [...(urls.length ? ["web"] : []), "chiefdelphi", "programs", "drive", "slack", "github",
      ...(team ? ["tba", "statbotics"] : [])],
  };
}
