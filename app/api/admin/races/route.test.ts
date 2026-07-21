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

  // ENG-326. This route has FOUR 400 branches that all return `validation_failed`, so a test
  // asserting only status+code is theatre — it passes with the guard deleted (ENG-324's lesson).
  // Assert the MESSAGE, which is the only discriminator.
  it.each([
    ["venue", { ...VALID, venue: "" }, /venue is required and cannot be blank/],
    ["venue (whitespace-only)", { ...VALID, venue: "   " }, /venue is required and cannot be blank/],
    ["raceDate", { ...VALID, raceDate: "" }, /raceDate is required and cannot be blank/],
    ["raceDate (whitespace-only)", { ...VALID, raceDate: "  " }, /raceDate is required and cannot be blank/],
    ["raceNumber", { ...VALID, raceNumber: "" }, /raceNumber is required and cannot be blank/],
    ["raceNumber (whitespace-only)", { ...VALID, raceNumber: "   " }, /raceNumber is required and cannot be blank/],
    // Regression guard (ENG-326 review): the ORIGINAL create route used a falsy check
    // (`if (!b?.venue)`), which rejected these. Routing through the shared helper must not
    // loosen that — venue and race_date are string columns and a JSON number/boolean/object
    // there is junk, not a natural key.
    ["venue (number 0)", { ...VALID, venue: 0 }, /venue is required and cannot be blank/],
    ["venue (boolean false)", { ...VALID, venue: false }, /venue is required and cannot be blank/],
    ["venue (number 7)", { ...VALID, venue: 7 }, /venue is required and cannot be blank/],
    ["venue (object)", { ...VALID, venue: { a: 1 } }, /venue is required and cannot be blank/],
    ["venue (array)", { ...VALID, venue: [] }, /venue is required and cannot be blank/],
    ["raceDate (number 0)", { ...VALID, raceDate: 0 }, /raceDate is required and cannot be blank/],
    ["raceDate (boolean false)", { ...VALID, raceDate: false }, /raceDate is required and cannot be blank/],
    ["venue (null)", { ...VALID, venue: null }, /venue is required and cannot be blank/],
    ["raceDate (null)", { ...VALID, raceDate: null }, /raceDate is required and cannot be blank/],
    ["raceNumber (null)", { ...VALID, raceNumber: null }, /raceNumber is required and cannot be blank/],
  ])("400s on a blank natural-key component: %s", async (_label, body, message) => {
    asAdmin();
    state.tables.race = { mutate: { single: { id: "r1" } } };
    const r = await POST(postReq(body));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
    expect(j.error.message).toMatch(message);
    expect(state.calls.mutations.filter((m) => m.table === "race")).toHaveLength(0);
  });

  // Trimming is integrity, not cosmetics: "  Rosehill  " and "Rosehill" are DISTINCT values
  // under race_natural_key, so writing padding defeats dedup exactly the way a NULL does.
  it("trims every natural-key string before the insert", async () => {
    asAdmin();
    state.tables.race = { mutate: { single: { id: "r1" } } };
    const r = await POST(postReq({ venue: "  Rosehill  ", raceDate: "  2026-08-01  ", raceNumber: 5 }));
    expect(r.status).toBe(201);
    const insert = state.calls.mutations.find((m) => m.table === "race" && m.op === "insert");
    expect(insert?.values).toMatchObject({
      venue: "Rosehill",
      race_date: "2026-08-01",
      race_number: 5,
    });
  });

  // The padded and the unpadded create must produce the SAME natural key — that identity is
  // what lets the DB's unique index fire and return 409 instead of a second row.
  it("a padded then an unpadded create collide on the natural key → 409, not two rows", async () => {
    asAdmin();
    state.tables.race = { mutate: { single: { id: "r1" } } };
    const first = await POST(postReq({ venue: "  Rosehill  ", raceDate: "2026-08-01", raceNumber: 7 }));
    expect(first.status).toBe(201);

    // Script the DB's unique-violation for the second write. NB the fake cannot enforce
    // uniqueness, so the 409 below is scripted, not proven — the load-bearing assertion is
    // that BOTH inserts carry the IDENTICAL normalized key (checked at the end), which is
    // what makes the real index fire. That assertion is the one that dies under the trim mutation.
    state.tables.race = { mutate: { error: { code: "23505", message: "duplicate key" } } };
    const second = await POST(postReq({ venue: "Rosehill", raceDate: "2026-08-01", raceNumber: 7 }));
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe("race_exists");

    const inserts = state.calls.mutations.filter((m) => m.table === "race" && m.op === "insert");
    expect(inserts).toHaveLength(2);
    expect(inserts[0].values).toMatchObject({ venue: "Rosehill", race_date: "2026-08-01", race_number: 7 });
    expect(inserts[1].values).toMatchObject({ venue: "Rosehill", race_date: "2026-08-01", race_number: 7 });
    // Identical natural keys is the whole point: without the trim these differ and the DB
    // would happily hold both rows.
    expect(inserts[0].values).toEqual(inserts[1].values);
  });
});
