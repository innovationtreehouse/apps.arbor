import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, between, desc, eq, isNull, lte, notInArray, sql } from "drizzle-orm";
import { socialPosts } from "./schema.js";
import type {
  SocialPlatform,
  SocialPost,
  SocialPostStatus,
  NewSocialPost,
  SocialPostPatch,
  SocialPostStore,
} from "./social-store.js";

const TERMINAL: SocialPostStatus[] = ["posted", "pulled", "withdrawn"];
const NOT_NEAR: SocialPostStatus[] = ["pending_review", "pulled", "withdrawn"];
const toDate = (s: string | null | undefined) => (s == null ? s : new Date(s));

/* v8 ignore start */
export class PostgresSocialPostStore implements SocialPostStore {
  private db: ReturnType<typeof drizzle>;

  constructor(connectionString: string) {
    this.db = drizzle(postgres(connectionString), { schema: { socialPosts } });
  }

  async create(post: NewSocialPost): Promise<SocialPost> {
    const [row] = await this.db
      .insert(socialPosts)
      .values({ ...post, scheduled_at: new Date(post.scheduled_at) })
      .onConflictDoNothing({ target: socialPosts.slack_view_id })
      .returning();
    if (row) return toPost(row);
    const [existing] = await this.db
      .select()
      .from(socialPosts)
      .where(eq(socialPosts.slack_view_id, post.slack_view_id!));
    return toPost(existing);
  }

  async get(id: number): Promise<SocialPost | undefined> {
    const [row] = await this.db.select().from(socialPosts).where(eq(socialPosts.id, id));
    return row && toPost(row);
  }

  async update(id: number, patch: SocialPostPatch, expectUpdatedAt?: string): Promise<SocialPost | undefined> {
    const [row] = await this.db
      .update(socialPosts)
      .set({
        ...patch,
        scheduled_at: toDate(patch.scheduled_at) ?? undefined,
        posted_at: toDate(patch.posted_at),
        pulled_at: toDate(patch.pulled_at),
        nudged_at: toDate(patch.nudged_at),
        updated_at: new Date(),
      })
      .where(
        and(
          eq(socialPosts.id, id),
          // defaultNow() stores microseconds; the ISO version only carries milliseconds
          expectUpdatedAt === undefined
            ? undefined
            : sql`date_trunc('milliseconds', ${socialPosts.updated_at}) = ${new Date(expectUpdatedAt)}`
        )
      )
      .returning();
    if (!row && expectUpdatedAt !== undefined) return undefined;
    if (!row) throw new Error(`social post ${id} not found`);
    return toPost(row);
  }

  async listOpen(): Promise<SocialPost[]> {
    const rows = await this.db
      .select()
      .from(socialPosts)
      .where(notInArray(socialPosts.status, TERMINAL))
      .orderBy(desc(socialPosts.created_at), desc(socialPosts.id));
    return rows.map(toPost);
  }

  async listNear(platform: SocialPlatform, scheduledAt: string, windowMs: number): Promise<SocialPost[]> {
    const t = new Date(scheduledAt).getTime();
    const rows = await this.db
      .select()
      .from(socialPosts)
      .where(
        and(
          eq(socialPosts.platform, platform),
          notInArray(socialPosts.status, NOT_NEAR),
          between(socialPosts.scheduled_at, new Date(t - windowMs), new Date(t + windowMs))
        )
      );
    return rows.map(toPost);
  }

  async listDueForNudge(now: string): Promise<SocialPost[]> {
    const rows = await this.db
      .select()
      .from(socialPosts)
      .where(
        and(
          eq(socialPosts.status, "approved"),
          lte(socialPosts.scheduled_at, new Date(now)),
          isNull(socialPosts.nudged_at)
        )
      );
    return rows.map(toPost);
  }
}

function toPost(row: typeof socialPosts.$inferSelect): SocialPost {
  return {
    ...row,
    platform: row.platform as SocialPlatform,
    status: row.status as SocialPostStatus,
    scheduled_at: row.scheduled_at.toISOString(),
    posted_at: row.posted_at?.toISOString() ?? null,
    pulled_at: row.pulled_at?.toISOString() ?? null,
    nudged_at: row.nudged_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
/* v8 ignore stop */
