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
  state.tables.app_user = { select: { single: { is_admin: true } } };
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

  it("returns the tile counts + quiet horses for an admin", async () => {
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
    state.tables.reaction = { select: { count: 3420 } };
    state.tables.bookmark = { select: { count: 612 } };
    state.tables.subscription = { select: { count: 412 } };
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
    expect(j.data.reactions).toBe(3420);
    expect(j.data.saves).toBe(612);
    expect(j.data.members).toBe(412);

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
