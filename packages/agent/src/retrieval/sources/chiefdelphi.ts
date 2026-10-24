import type { Source } from "../plan.js";
import { getJson, htmlToText } from "./http.js";

const CD = "https://www.chiefdelphi.com";

// Discourse JSON API, no login: search for topics, then read the first posts of the top three.
export const chiefdelphi: Source = async (plan, { signal }) => {
  const search = await getJson<{ topics?: { id: number; title: string; slug: string }[] }>(
    `${CD}/search.json?q=${encodeURIComponent(plan.query)}`, {}, signal);
  const docs = await Promise.all((search.topics ?? []).slice(0, 3).map(async (t) => {
    const topic = await getJson<{ post_stream?: { posts?: { username: string; cooked: string }[] } }>(`${CD}/t/${t.id}.json`, {}, signal);
    const posts = (topic.post_stream?.posts ?? []).slice(0, 8);
    return {
      source: "chiefdelphi",
      url: `${CD}/t/${t.slug}/${t.id}`,
      title: t.title,
      text: posts.map((p) => `${p.username}: ${htmlToText(p.cooked)}`).join("\n"),
    };
  }));
  return { docs };
};
