import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));

import { GET } from "./route";

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 864e5).toISOString();

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true }, rows: [{ id: "admin-1" }] } };
}
function asNonAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: false } } };
}

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("GET /api/admin/analytics", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await GET();
    expect(r.status).toBe(403);
  });

  it("returns the tile counts + quiet horses for an admin, excluding admin reactions/saves (ENG-984)", async () => {
    asAdmin();
    // post: count drives postsThisWeek; rows drive last-post recency.
    state.tables.post = {
      select: {
        count: 68,
        rows: [
          { horse_id: "h1", published_at: iso(2) }, // posted this week
          { horse_id: "h6", published_at: iso(20) }, // stale
        ],
      },
    };
    // reactions/saves are now recomputed member-only from raw rows, not a
    // head-count — one admin row in each must NOT be counted.
    state.tables.reaction = {
      select: {
        rows: [
          { user_id: "admin-1" },
          { user_id: "member-1" },
          { user_id: "member-2" },
        ],
      },
    };
    state.tables.bookmark = {
      select: {
        rows: [{ user_id: "admin-1" }, { user_id: "member-1" }],
      },
    };
    state.tables.subscription = {
      select: {
        rows: [
          { status: "trial", user: { is_admin: false } },
          { status: "active", user: { is_admin: false } },
          { status: "active", user: [{ is_admin: false }] },
          // Operator's own signup trial — must NOT count as a member (ENG-315).
          { status: "trial", user: { is_admin: true } },
        ],
      },
    };
    state.tables.horse = {
      select: {
        rows: [
          { id: "h1", display_name: "Mahogany", racing_name: "MAHOGANY (AUS)", training_status: "racing", photo_url: null },
          { id: "h6", display_name: "Winx", racing_name: "WINX (AUS)", training_status: "retired", photo_url: null },
          { id: "h8", display_name: "Saxon Warrior", racing_name: null, training_status: "racing", photo_url: null },
        ],
      },
    };

    const r = await GET();
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.postsThisWeek).toBe(68);
    expect(j.data.reactions).toBe(2); // admin-1's reaction excluded
    expect(j.data.saves).toBe(1); // admin-1's save excluded
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

// ---------------------------------------------------------------------------
// ERROR PATH (ENG-984 review, MUST-FIX 1)
//
// ENG-984 made this route throwable for the first time: `getAnalytics` now
// calls `getAdminUserIds`, which throws by design rather than silently
// returning an empty admin set. Before this diff every read here degraded to
// `?? 0` / `?? []` and the route could not reject, so it carried no boundary.
// Without one the rejection escapes `lib/api/envelope.ts` completely — the
// client gets no `{ok:false, code}` body AND the raw Postgres message rides
// out with it.
//
// This mirrors `posts/[id]/route.test.ts`'s
// "500s with a generic message when the post read errors (no schema/SQL
// leakage)" — the same property, on the one route that was missing it.
// ---------------------------------------------------------------------------
describe("GET /api/admin/analytics — error path", () => {
  it("500s in the envelope when the admin-exclusion read fails (no schema/SQL leakage)", async () => {
    asAdmin();
    // The admin-ids read is the first thing `getAnalytics` does, and the one
    // this diff made throwing. Raw Postgres text, exactly as PostgREST returns.
    state.tables.app_user = {
      select: {
        single: { is_admin: true },
        error: { message: 'relation "app_user" does not exist' },
      },
    };

    const r = await GET();
    expect(r.status).toBe(500);

    const body = await r.json();
    expect(body.data, "an error response must carry no data payload").toBeUndefined();
    expect(body.error.code).toBe("query_failed");
    expect(body.error.message).toBe("Could not load analytics.");

    // The whole serialised response must not carry schema or SQL detail.
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/relation/i);
    expect(raw).not.toMatch(/app_user/);
    expect(raw).not.toMatch(/does not exist/i);
    expect(raw).not.toMatch(/admin exclusion/i);
  });
});
