import { fetchAllowed } from "@arbor/mcp-url-fetcher";
import type { Source } from "../plan.js";
import { htmlTitle, htmlToText } from "./http.js";

const WIKI = "https://programs.innovationtreehouse.org/";
const WAKING = "the wiki was waking (HTTP 503 \"wiki is starting\"); try again in a minute";
// The wiki scales to zero and answers 503 while it boots. 65 s of waits is the full
// retry (used by /squirrel-admin check); inside a message the research budget aborts sooner.
export const WAKE_DELAYS_MS = [5_000, 10_000, 20_000, 30_000];

// ponytail: front page only; add the wiki's own search once its software is known.
export const programs: Source = async (_plan, { urls, signal }) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchAllowed(urls, WIKI, signal);
    if (res.status === 503 && attempt < WAKE_DELAYS_MS.length) {
      await res.body?.cancel();
      const waited = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(true), WAKE_DELAYS_MS[attempt]);
        signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(false); }, { once: true });
      });
      if (!waited) throw new Error(WAKING);
      continue;
    }
    if (res.status === 503) throw new Error(WAKING);
    if (!res.ok) throw new Error(`HTTP ${res.status} from the programs wiki`);
    const body = await res.text();
    return { docs: [{ source: "programs", url: WIKI, title: htmlTitle(body) ?? "Programs wiki", text: htmlToText(body) }] };
  }
};
