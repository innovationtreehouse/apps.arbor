import { describe, expect, it } from "vitest";
import type { SocialPost } from "@arbor/db";
import { buildSocialReviewPrompt, checkPlatformLimits } from "../social-review.js";

const base = {
  platform: "facebook" as const,
  content: "Join us Saturday for the open house.",
  media_url: null,
  scheduled_at: "2026-10-20T15:00:00Z",
};

function nearbyPost(id: number, content: string): SocialPost {
  return {
    ...base,
    id,
    content,
    media_url: null,
    status: "approved",
    review: null,
    channel: null,
    thread_ts: null,
    approved_by: null,
    objected_by: null,
    posted_by: null,
    posted_at: null,
    nudged_at: null,
    proposer_id: "U1",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  };
}

describe("checkPlatformLimits", () => {
  it("returns no violations for a clean post", () => {
    expect(checkPlatformLimits(base)).toEqual([]);
  });

  it("flags an over-length X post", () => {
    const v = checkPlatformLimits({ ...base, platform: "x", content: "a".repeat(281) });
    expect(v.some((s) => s.includes("280"))).toBe(true);
  });

  it("flags instagram without media", () => {
    const v = checkPlatformLimits({ ...base, platform: "instagram", media_url: null });
    expect(v).toEqual(["instagram requires a media_url."]);
  });

  it("flags a non-http media URL", () => {
    const v = checkPlatformLimits({ ...base, media_url: "ftp://drive/file" });
    expect(v).toEqual(["media_url must be an http(s) link."]);
  });

  it("flags too many hashtags on X", () => {
    const content = "#a #b #c #d #e #f";
    const v = checkPlatformLimits({ ...base, platform: "x", content });
    expect(v.some((s) => s.includes("6 hashtags"))).toBe(true);
  });
});

describe("buildSocialReviewPrompt", () => {
  it("includes content, violations and nearby post ids", () => {
    const content = "Guaranteed results! #one #two #three #four #five #six";
    const prompt = buildSocialReviewPrompt(
      { ...base, platform: "x", content },
      [nearbyPost(41, "Open house reminder"), nearbyPost(42, "Volunteer sign-up")]
    );
    expect(prompt).toContain(content);
    expect(prompt).toContain("6 hashtags exceeds");
    expect(prompt).toContain("#41");
    expect(prompt).toContain("#42");
    expect(prompt).toContain("VERDICT: OK");
  });
});
