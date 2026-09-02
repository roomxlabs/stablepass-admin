import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";
import { recordCalls, blankRecord, selectFor, type CallRecord } from "@/lib/testing/call-recorder";

const state: FakeState = blankState();
const rec: CallRecord = blankRecord();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => recordCalls(makeFakeClient(state), rec),
}));

import { GET } from "./route";

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 864e5).toISOString();

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}
function asNonAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: false } } };
}

beforeEach(() => {
  Object.assign(state, blankState());
  Object.assign(rec, blankRecord());
});

describe("GET /api/admin/analytics", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await GET();
    expect(r.status).toBe(403);
  });

  it("returns the tile counts + quiet horses for an admin", async () => {
    asAdmin();
    // `post` is now a single head:true count for postsThisWeek — last-post
    // recency rides in on each horse's own embed instead of a read of every
    // published post in the database.
    state.tables.post = { select: { count: 68 } };
    state.tables.reaction = { select: { count: 3420 } };
    state.tables.bookmark = { select: { count: 612 } };
    // Two head:true counts, trial then active. The staff exclusion is a filter
    // on the `!inner` app_user embed now, so it never reaches JS: 1 + 2 = 3.
    state.tables.subscription = { selectQueue: [{ count: 1 }, { count: 2 }] };
    state.tables.horse = {
      select: {
        rows: [
          { id: "h1", display_name: "Mahogany", racing_name: "MAHOGANY (AUS)", training_status: "racing", photo_url: null, posts: [{ published_at: iso(2) }] }, // posted this week
          { id: "h6", display_name: "Winx", racing_name: "WINX (AUS)", training_status: "retired", photo_url: null, posts: [{ published_at: iso(20) }] }, // stale
          { id: "h8", display_name: "Saxon Warrior", racing_name: null, training_status: "racing", photo_url: null, posts: [] },
        ],
      },
    };

    const r = await GET();
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.postsThisWeek).toBe(68);
    expect(j.data.reactions).toBe(3420);
    expect(j.data.saves).toBe(612);
    expect(j.data.members).toBe(3); // 4 subscription rows, one is staff (excluded)

    // h1 posted within the week → NOT quiet. h6 (stale 20d) + h8 (never) are.
    const quiet = j.data.quietHorses as { id: string; daysSinceLastPost: number | null; name: string }[];
    expect(quiet.map((q) => q.id).sort()).toEqual(["h6", "h8"]);
    // Longest-quiet first; never-posted sinks last.
    expect(quiet[0].id).toBe("h6");
    expect(quiet[0].daysSinceLastPost).toBeGreaterThanOrEqual(19);
    expect(quiet[quiet.length - 1].id).toBe("h8");
    expect(quiet[quiet.length - 1].daysSinceLastPost).toBeNull();
    // Falls back to display_name when racing_name is null.
    expect(quiet.find((q) => q.id === "h8")?.name).toBe("Saxon Warrior");
  });

  it("takes each horse's last post from an embedded ordered limit-1, not a post scan", async () => {
    asAdmin();
    state.tables.post = { select: { count: 0 } };
    state.tables.subscription = { selectQueue: [{ count: 0 }, { count: 0 }] };
    state.tables.horse = { select: { rows: [] } };
    await GET();

    const projection = selectFor(rec, "horse")!;
    expect(projection).toContain("posts:post(published_at)");
    // The embed is filtered to published rows, ordered newest-first INSIDE the
    // embed, and capped at one row THERE — a top-level limit would return one
    // horse, and no filter would let a draft masquerade as the last post.
    expect(rec.filters).toContain("horse.posts.status=published");
    expect(rec.orders).toContain("horse.posts.published_at desc");
    expect(rec.limits).toContain("horse.posts=1");
    // No unbounded read of `post` rows — the only post query is a count.
    const postReads = rec.selectOptions.filter((o) => o.table === "post");
    expect(postReads).toHaveLength(1);
    expect(postReads[0]).toMatchObject({ count: "exact", head: true });
  });

  it("counts members with head:true, excluding staff in the query", async () => {
    asAdmin();
    state.tables.post = { select: { count: 0 } };
    state.tables.horse = { select: { rows: [] } };
    state.tables.subscription = { selectQueue: [{ count: 4 }, { count: 9 }] };

    const r = await GET();
    const j = await r.json();
    expect(j.data.members).toBe(13);

    const counts = rec.selectOptions.filter((o) => o.table === "subscription");
    expect(counts).toHaveLength(2);
    for (const c of counts) expect(c).toMatchObject({ count: "exact", head: true });
    expect(rec.nots).toContain("subscription.user.is_admin=not.is.true");
  });

  it("tolerates an empty backend (zeros + no quiet horses)", async () => {
    asAdmin();
    const r = await GET();
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.postsThisWeek).toBe(0);
    expect(j.data.reactions).toBe(0);
    expect(j.data.quietHorses).toEqual([]);
  });
});
