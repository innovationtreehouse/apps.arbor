import type { ConfigStore } from "@arbor/db";

export const RATE_WINDOW_MS = 60_000;
export const RATE_THRESHOLD = 3;

/**
 * Records a mention for the channel (ConfigStore key `rate:<channel>`, so it
 * survives across Lambda invocations) and returns true once the channel has
 * RATE_THRESHOLD or more mentions within RATE_WINDOW_MS (holdoff).
 */
export async function recordAndCheck(
  configStore: ConfigStore,
  channel: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const key = `rate:${channel}`;
  const raw = await configStore.get(key);
  const timestamps: number[] = raw ? JSON.parse(raw) : [];
  const recent = timestamps.filter((t) => t > nowMs - RATE_WINDOW_MS);
  recent.push(nowMs);
  await configStore.set(key, JSON.stringify(recent));
  return recent.length >= RATE_THRESHOLD;
}
