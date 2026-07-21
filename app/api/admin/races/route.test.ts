import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));

import { GET, POST } from "./route";

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}
function asNonAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: false } } };
}
const postReq = (body: unknown) =>
  new Request("http://t/api/admin/races", { method: "POST", body: JSON.stringify(body) });

const VALID = { venue: "Randwick", raceDate: "2026-08-01", raceNumber: 5 };

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("GET /api/admin/races", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await GET(new Request("http://t/api/admin/races"));
    expect(r.status).toBe(403);
  });

  it("401s with no session (guardrail)", async () => {
    state.user = null;
    const r = await GET(new Request("http://t/api/admin/races"));
    expect(r.status).toBe(401);
  });

  it("lists races for an admin", async () => {
    asAdmin();
    state.tables.race = { select: { rows: [{ id: "r1", venue: "Randwick", source: "manual" }] } };
    const r = await GET(new Request("http://t/api/admin/races"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data).toHaveLength(1);
    expect(j.data[0].id).toBe("r1");
  });
});

describe("POST /api/admin/races — create a manual race", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await POST(postReq(VALID));
    expect(r.status).toBe(403);
  });

  it("creates the race with source='manual' → 201", async () => {
    asAdmin();
    state.tables.race = { mutate: { single: { id: "r1", venue: "Randwick", source: "manual" } } };
    const r = await POST(postReq(VALID));
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.data.source).toBe("manual");

    const insert = state.calls.mutations.find((m) => m.table === "race" && m.op === "insert");
    expect(insert?.values).toMatchObject({
      venue: "Randwick",
      race_date: "2026-08-01",
      race_number: 5,
      status: "upcoming",
      source: "manual",
    });
  });

  it("409s on the natural key (venue, date, number) — never two rows for one real race", async () => {
    asAdmin();
    state.tables.race = { mutate: { error: { code: "23505", message: "duplicate key" } } };
    const r = await POST(postReq(VALID));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error.code).toBe("race_exists");
  });

  it("400s when the natural-key parts are missing", async () => {
    asAdmin();
    expect((await POST(postReq({ venue: "Randwick", raceNumber: 5 }))).status).toBe(400);
    expect((await POST(postReq({ raceDate: "2026-08-01", raceNumber: 5 }))).status).toBe(400);
    expect((await POST(postReq({ venue: "Randwick", raceDate: "2026-08-01" }))).status).toBe(400);
  });

  // Number("abc") is NaN, which JSON-serialises to null — and a NULL matches nothing
  // in a unique constraint, so an unvalidated raceNumber would punch straight through
  // the natural-key dedup and allow unlimited duplicate races.
  it("rejects a non-integer raceNumber rather than inserting NULL", async () => {
    asAdmin();
    state.tables.race = { mutate: { single: { id: "r1" } } };
    const r = await POST(postReq({ ...VALID, raceNumber: "abc" }));
    expect(r.status).toBe(400);
    expect(state.calls.mutations.filter((m) => m.table === "race")).toHaveLength(0);
  });

  it("rejects a zero or negative raceNumber", async () => {
    asAdmin();
    expect((await POST(postReq({ ...VALID, raceNumber: 0 }))).status).toBe(400);
    expect((await POST(postReq({ ...VALID, raceNumber: -3 }))).status).toBe(400);
  });

  it("rejects a non-integer distanceM", async () => {
    asAdmin();
    const r = await POST(postReq({ ...VALID, distanceM: "long" }));
    expect(r.status).toBe(400);
  });

  it("never writes an odds or betting field (guardrail §6)", async () => {
    asAdmin();
    state.tables.race = { mutate: { single: { id: "r1" } } };
    await POST(postReq({ ...VALID, odds: "5.50", bookmaker: "x", wager: 10 }));
    const insert = state.calls.mutations.find((m) => m.table === "race" && m.op === "insert");
    const keys = Object.keys(insert?.values ?? {});
    expect(keys).not.toContain("odds");
    expect(keys).not.toContain("bookmaker");
    expect(keys).not.toContain("wager");
  });
});
