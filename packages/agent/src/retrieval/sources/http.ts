// A source that needs a key or URL nobody set; reported as "not configured", not a failure.
export class NotConfigured extends Error {}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Squirrel-Bot/1.0", Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res;
}

export async function getJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  return (await get(url, headers)).json() as Promise<T>;
}

export function htmlTitle(html: string): string | undefined {
  return html.match(/<title[^>]*>([^<]*)/i)?.[1]?.trim() || undefined;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
