import { fetchAllowed } from "@arbor/mcp-url-fetcher";
import type { Source } from "../plan.js";
import { htmlTitle, htmlToText } from "./http.js";

const WIKI = "https://programs.innovationtreehouse.org/";
// The wiki scales to zero and answers 503 "wiki is starting" while it boots.
export const WAKE_DELAYS_MS = [5_000, 10_000, 20_000, 30_000];

// ponytail: front page only; add the wiki's own search once its software is known.
export const programs: Source = async (_plan, { urls }) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchAllowed(urls, WIKI);
    if (res.status === 503 && attempt < WAKE_DELAYS_MS.length) {
      await res.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, WAKE_DELAYS_MS[attempt]));
      continue;
    }
    if (res.status === 503) throw new Error("the wiki was waking (still HTTP 503 after ~90 s); try again in a minute");
    if (!res.ok) throw new Error(`HTTP ${res.status} from the programs wiki`);
    const body = await res.text();
    return { docs: [{ source: "programs", url: WIKI, title: htmlTitle(body) ?? "Programs wiki", text: htmlToText(body) }] };
  }
};
