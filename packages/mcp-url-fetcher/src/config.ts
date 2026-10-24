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
      if (key.endsWith("*") && url.startsWith(key.slice(0, -1))) return entry;
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
