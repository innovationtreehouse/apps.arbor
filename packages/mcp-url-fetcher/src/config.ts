import type { UrlStore, UrlEntry } from "@arbor/db";

export type { UrlEntry };

export class UrlConfig {
  private urls: Map<string, UrlEntry> = new Map();
  private readonly store: UrlStore;
  private readonly pollIntervalMs: number;

  constructor(store: UrlStore) {
    this.store = store;
    this.pollIntervalMs =
      parseInt(process.env.URL_POLL_INTERVAL_S ?? "60", 10) * 1000;
  }

  async load(): Promise<void> {
    const entries = await this.store.listEnabled();
    this.urls = new Map(entries.map((e) => [e.url, e]));
    console.error(`[url-fetcher] Loaded ${this.urls.size} URLs`);
  }

  startPolling(): void {
    setInterval(() => {
      this.load().catch((err) =>
        console.error("[url-fetcher] Failed to reload URL config:", err)
      );
    }, this.pollIntervalMs);
  }

  // Exact entry first, then any "prefix*" wildcard entry.
  private match(url: string): UrlEntry | undefined {
    const exact = this.urls.get(url);
    if (exact) return exact;
    for (const [key, entry] of this.urls) {
      if (key.endsWith("*") && prefixMatches(key.slice(0, -1), url)) return entry;
    }
    return undefined;
  }

  isAllowed(url: string): boolean {
    return this.match(url) !== undefined;
  }

  getAll(): UrlEntry[] {
    return Array.from(this.urls.values());
  }

  getDescription(url: string): string {
    return this.match(url)?.description ?? "";
  }
}

// Same origin, and the path continues at a boundary: "https://a.com/docs" allows
// /docs, /docs/x and /docs?q but not /docs-evil; "https://a.com" never allows a.com.evil.com.
export function prefixMatches(prefix: string, url: string): boolean {
  try {
    const p = new URL(prefix), u = new URL(url);
    const pp = p.pathname + p.search, up = u.pathname + u.search;
    if (p.origin !== u.origin || !up.startsWith(pp)) return false;
    return pp.endsWith("/") || up.length === pp.length || "/?".includes(up[pp.length]);
  } catch {
    return false;
  }
}
