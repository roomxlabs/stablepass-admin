import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));

import { GET } from "./route";

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

describe("GET /api/admin/racing-matches", () => {
  it("401s with no session (guardrail)", async () => {
    state.user = null;
    const r = await GET();
    expect(r.status).toBe(401);
  });

  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await GET();
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("forbidden");
  });

  it("returns an empty queue when nothing is pending", async () => {
    asAdmin();
    state.tables.horse_match_proposal = { select: { rows: [] } };
    const r = await GET();
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data).toEqual([]);
    expect(j.meta.count).toBe(0);
  });

  it("pairs each proposal with its platform horse and trainer", async () => {
    asAdmin();
    state.tables.horse_match_proposal = {
      select: {
        rows: [
          {
            id: "p1",
            horse_id: "h1",
            racing_api_id: "RA-991",
            created_at: "2026-07-20T00:00:00.000Z",
            evidence: {
              name: "Northern Light",
              sire: "Snitzel",
              dam: "Bel Esprit",
              age: 4,
              sex: "Mare",
              colour: "Bay",
              trainer: "C. Waller",
            },
          },
        ],
      },
    };
    state.tables.horse = {
      select: {
        rows: [
          {
            id: "h1",
            display_name: "Snitzel x Bel Esprit",
            racing_name: "Northern Light",
            sire: "Snitzel",
            dam: "Bel Esprit",
            foaling_year: 2022,
            sex: "Mare",
            colour: "Chestnut",
            trainer_id: "t1",
            racing_api_id: null,
          },
        ],
      },
    };
    state.tables.trainer = {
      select: { rows: [{ id: "t1", name: "Chris Waller", display_name: "C. Waller" }] },
    };

    const r = await GET();
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data).toHaveLength(1);
    expect(j.data[0]).toEqual({
      id: "p1",
      racingApiId: "RA-991",
      createdAt: "2026-07-20T00:00:00.000Z",
      horse: {
        id: "h1",
        displayName: "Snitzel x Bel Esprit",
        racingName: "Northern Light",
        sire: "Snitzel",
        dam: "Bel Esprit",
        foalingYear: 2022,
        sex: "Mare",
        colour: "Chestnut",
        trainer: "C. Waller",
        racingApiId: null,
      },
      evidence: {
        name: "Northern Light",
        sire: "Snitzel",
        dam: "Bel Esprit",
        age: 4,
        sex: "Mare",
        colour: "Bay",
        trainer: "C. Waller",
      },
    });
  });

  it("never projects an owner field even if one reaches the evidence column (guardrail)", async () => {
    asAdmin();
    state.tables.horse_match_proposal = {
      select: {
        rows: [
          {
            id: "p1",
            horse_id: "h1",
            racing_api_id: "RA-1",
            created_at: "2026-07-20T00:00:00.000Z",
            // RF1's CHECK should stop these ever landing; the BFF allowlist is
            // the second line of defence.
            evidence: {
              name: "Northern Light",
              owner: "J. Smith",
              owner_email: "j@example.com",
              odds: "5/1",
            },
          },
        ],
      },
    };
    state.tables.horse = {
      select: {
        rows: [
          {
            id: "h1",
            display_name: "Northern Light",
            racing_name: null,
            sire: null,
            dam: null,
            foaling_year: null,
            sex: null,
            colour: null,
            trainer_id: null,
            racing_api_id: null,
          },
        ],
      },
    };

    const r = await GET();
    const body = await r.text();
    // toEqual (not toMatchObject) so a newly leaked field fails the test.
    expect(JSON.parse(body).data[0].evidence).toEqual({ name: "Northern Light" });
    expect(body).not.toContain("J. Smith");
    expect(body).not.toContain("owner");
    expect(body).not.toContain("odds");
  });

  it("reads ONLY pending proposals — resolved ones must not resurface", async () => {
    asAdmin();
    state.tables.horse_match_proposal = { select: { rows: [] } };
    await GET();
    // `.eq()` is a no-op in the fake, so without this the WHERE clause could be
    // dropped and every test would stay green while confirmed/rejected
    // proposals reappeared in the queue forever.
    expect(state.calls.filters).toContainEqual({
      table: "horse_match_proposal",
      op: "eq",
      column: "status",
      value: "pending",
    });
  });

  it("500s generically when the read fails — no Postgres text leaks", async () => {
    asAdmin();
    state.tables.horse_match_proposal = {
      select: { error: { message: 'permission denied for table horse_match_proposal' } },
    };
    const r = await GET();
    expect(r.status).toBe(500);
    const body = await r.text();
    expect(JSON.parse(body).error.code).toBe("query_failed");
    expect(body).not.toContain("permission denied");
  });
});
