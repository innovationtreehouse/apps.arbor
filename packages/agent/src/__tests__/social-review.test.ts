import { describe, expect, it } from "vitest";
import type { SocialPost } from "@arbor/db";
import { buildSocialReviewPrompt, checkPlatformLimits } from "../social-review.js";

const base = {
  platform: "facebook" as const,
  content: "Join us Saturday for the open house.",
  media_url: null,
  scheduled_at: "2026-10-20T15:00:00Z",
};

const DRIVE_URL = "https://drive.google.com/file/d/abc/view";
const LONG_URL = "https://example.com/" + "x".repeat(200); // counts 23 on X, not its length

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
    expect(v.some((s) => s.includes("approximate X weighting"))).toBe(true);
  });

  it("counts each X URL as 23 regardless of its length", () => {
    const clean = "a".repeat(256) + " " + LONG_URL; // 256 + 1 + 23 = 280
    expect(checkPlatformLimits({ ...base, platform: "x", content: clean })).toEqual([]);

    const over = "a".repeat(257) + " " + LONG_URL; // 281
    expect(checkPlatformLimits({ ...base, platform: "x", content: over })).toHaveLength(1);
  });

  it("counts CJK characters as double on X", () => {
    expect(checkPlatformLimits({ ...base, platform: "x", content: "漢".repeat(140) })).toEqual([]);
    expect(checkPlatformLimits({ ...base, platform: "x", content: "漢".repeat(141) })).toHaveLength(1);
  });

  it("does not apply X weighting to other platforms", () => {
    // 141 CJK characters: over X's weighted 280, but instagram counts code points (141 < 2200)
    const v = checkPlatformLimits({ ...base, platform: "instagram", media_url: DRIVE_URL, content: "漢".repeat(141) });
    expect(v).toEqual([]);
  });

  it("flags instagram without media", () => {
    const v = checkPlatformLimits({ ...base, platform: "instagram", media_url: null });
    expect(v).toEqual(["instagram requires a media_url."]);
  });

  it("flags a non-http media URL", () => {
    const v = checkPlatformLimits({ ...base, media_url: "ftp://drive/file" });
    expect(v).toEqual(["media_url must be an http(s) link."]);
  });

  it("counts non-ASCII hashtags on instagram", () => {
    const content = Array.from({ length: 31 }, (_, i) => `#タグ${i}`).join(" ");
    const v = checkPlatformLimits({ ...base, platform: "instagram", media_url: DRIVE_URL, content });
    expect(v.some((s) => s.includes("31 hashtags exceeds the 30 limit"))).toBe(true);
  });

  it("has no hashtag cap on X", () => {
    const content = "#a #b #c #d #e #f #g #h #i #j";
    expect(checkPlatformLimits({ ...base, platform: "x", content })).toEqual([]);
  });
});

describe("buildSocialReviewPrompt", () => {
  it("includes content, violations and nearby post ids", () => {
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ");
    const content = `Guaranteed results! ${tags}`;
    const prompt = buildSocialReviewPrompt(
      { ...base, platform: "instagram", media_url: DRIVE_URL, content },
      [nearbyPost(41, "Open house reminder"), nearbyPost(42, "Volunteer sign-up")]
    );
    expect(prompt).toContain(content);
    expect(prompt).toContain("31 hashtags exceeds");
    expect(prompt).toContain("#41");
    expect(prompt).toContain("#42");
    expect(prompt).toContain("VERDICT: OK");
    expect(prompt).toContain("confirm it is readable with your Drive tools");
  });

  it("says there is no hashtag limit on X rather than printing Infinity", () => {
    const prompt = buildSocialReviewPrompt({ ...base, platform: "x", content: "hi" }, []);
    expect(prompt).toContain("no hashtag limit");
    expect(prompt).not.toContain("Infinity");
  });
});
