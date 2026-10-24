import { fetchAllowed } from "@arbor/mcp-url-fetcher";
import type { Doc, Source } from "../plan.js";
import { errorMessage, htmlTitle, htmlToText } from "./http.js";

// Allowlisted pages (FIRST sites, docs, links in the question) via the url-fetcher's guard.
// PDFs (game manuals) are returned as a link card; extraction is out of scope.
export const web: Source = async (plan, { urls }) => {
  const results = await Promise.allSettled(plan.urls.map(async (url): Promise<Doc> => {
    const res = await fetchAllowed(urls, url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("pdf")) {
      await res.body?.cancel();
      return { source: "web", url, title: url.split("/").pop() || url, text: "PDF document (text not extracted); open the link to read it.", link: true };
    }
    if (!/text|json/.test(type)) throw new Error(`unsupported content type "${type}" for ${url}`);
    const body = await res.text();
    return { source: "web", url, title: htmlTitle(body) ?? url, text: htmlToText(body) };
  }));
  const docs = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const failed = results.flatMap((r) => (r.status === "rejected" ? [errorMessage(r.reason)] : []));
  if (failed.length && !docs.length) throw new Error(failed.join("; "));
  return { docs, note: failed.length ? failed.join("; ") : undefined };
};
