import type { SocialPlatform, SocialPost } from "@arbor/db";

export const PLATFORM_LIMITS: Record<SocialPlatform, { maxChars: number; maxHashtags: number; requiresMedia: boolean }> = {
  x: { maxChars: 280, maxHashtags: 5, requiresMedia: false },
  instagram: { maxChars: 2200, maxHashtags: 30, requiresMedia: true },
  facebook: { maxChars: 63206, maxHashtags: 30, requiresMedia: false },
};

type ReviewablePost = Pick<SocialPost, "platform" | "content" | "media_url">;

// Deterministic checks only; brand voice and risk judgement happen in the agent review.
export function checkPlatformLimits(post: ReviewablePost): string[] {
  const limits = PLATFORM_LIMITS[post.platform];
  const violations: string[] = [];
  if (post.content.length > limits.maxChars) {
    violations.push(`Over ${limits.maxChars} characters for ${post.platform} (${post.content.length}).`);
  }
  const hashtags = post.content.match(/#\w+/g)?.length ?? 0;
  if (hashtags > limits.maxHashtags) {
    violations.push(`${hashtags} hashtags exceeds the ${limits.maxHashtags} limit for ${post.platform}.`);
  }
  if (limits.requiresMedia && !post.media_url) {
    violations.push(`${post.platform} requires a media_url.`);
  }
  if (post.media_url && !/^https?:\/\//i.test(post.media_url)) {
    violations.push("media_url must be an http(s) link.");
  }
  return violations;
}

export function buildSocialReviewPrompt(
  post: Pick<SocialPost, "platform" | "content" | "media_url" | "scheduled_at">,
  nearby: SocialPost[]
): string {
  const violations = checkPlatformLimits(post);
  const limits = PLATFORM_LIMITS[post.platform];
  const nearbyLines = nearby.length
    ? nearby.map((p) => `- #${p.id} ${p.scheduled_at}: ${p.content.slice(0, 80)}`).join("\n")
    : "(none)";
  return `Review this draft social media post for the ${post.platform} account before it is approved.

Platform limits: up to ${limits.maxChars} characters, up to ${limits.maxHashtags} hashtags, media ${limits.requiresMedia ? "required" : "optional"}.
Scheduled time: ${post.scheduled_at}
Media URL: ${post.media_url ?? "(none)"}

Draft content (verbatim):
\`\`\`
${post.content}
\`\`\`

Deterministic violations:
${violations.length ? violations.map((v) => `- ${v}`).join("\n") : "- none"}

Nearby posts on ${post.platform} (id, scheduled time, first 80 characters):
${nearbyLines}

Check:
(a) Brand voice: search Google Drive for the organisation's social media style guide. If you find one, compare the draft against it. If you cannot find one, say so.
(b) Risk and policy flags: sensitive topics, unsourced claims, personal data, legal exposure.
(c) Duplicates or conflicts with the nearby posts above.

Respond with a concise markdown verdict under 300 words. The first line must be exactly one of:
VERDICT: OK
VERDICT: REVISE
VERDICT: BLOCK
Follow it with bullets for each finding.`;
}
