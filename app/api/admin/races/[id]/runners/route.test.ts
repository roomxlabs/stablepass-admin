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
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const postReq = (body: unknown) =>
  new Request("http://t", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("GET /api/admin/races/:id/runners", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await GET(new Request("http://t"), ctx("r1"));
    expect(r.status).toBe(403);
  });

  it("lists runners for an admin", async () => {
    asAdmin();
    state.tables.race_horse = { select: { rows: [{ id: "rh1", horse_id: "h1" }] } };
    const r = await GET(new Request("http://t"), ctx("r1"));
    expect(r.status).toBe(200);
    expect((await r.json()).data).toHaveLength(1);
  });
});

describe("POST /api/admin/races/:id/runners — attach a runner", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await POST(postReq({ horseId: "h1" }), ctx("r1"));
    expect(r.status).toBe(403);
  });

  it("401s with no session (guardrail)", async () => {
    state.user = null;
    const r = await POST(postReq({ horseId: "h1" }), ctx("r1"));
    expect(r.status).toBe(401);
  });

  // Manual rows must be indistinguishable downstream: entry_status='confirmed' is
  // what the race-day sweep and the pushes key off.
  it("attaches with entry_status='confirmed' → 201", async () => {
    asAdmin();
    state.tables.race = { select: { single: { id: "r1" } } };
    state.tables.race_horse = {
      mutate: { single: { id: "rh1", race_id: "r1", horse_id: "h1", entry_status: "confirmed" } },
    };
    const r = await POST(postReq({ horseId: "h1", barrier: 4, jockey: "T. Berry" }), ctx("r1"));
    expect(r.status).toBe(201);

    const insert = state.calls.mutations.find((m) => m.table === "race_horse" && m.op === "insert");
    expect(insert?.payload).toMatchObject({
      race_id: "r1",
      horse_id: "h1",
      barrier: 4,
      jockey: "T. Berry",
      entry_status: "confirmed",
    });
    expect((await r.json()).data.entry_status).toBe("confirmed");
  });

  it("400s without a horseId", async () => {
    asAdmin();
    const r = await POST(postReq({}), ctx("r1"));
    expect(r.status).toBe(400);
  });

  it("404s when the race is missing", async () => {
    asAdmin();
    state.tables.race = { select: { single: null } };
    const r = await POST(postReq({ horseId: "h1" }), ctx("r1"));
    expect(r.status).toBe(404);
  });

  it("409s when the horse is already entered (a horse runs once per race)", async () => {
    asAdmin();
    state.tables.race = { select: { single: { id: "r1" } } };
    state.tables.race_horse = { mutate: { error: { code: "23505", message: "duplicate key" } } };
    const r = await POST(postReq({ horseId: "h1" }), ctx("r1"));
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("runner_exists");
  });

  it("never writes an odds or betting field (guardrail §6)", async () => {
    asAdmin();
    state.tables.race = { select: { single: { id: "r1" } } };
    state.tables.race_horse = { mutate: { single: { id: "rh1" } } };
    await POST(postReq({ horseId: "h1", odds: "3.20", bookmaker: "x" }), ctx("r1"));
    const insert = state.calls.mutations.find((m) => m.table === "race_horse" && m.op === "insert");
    const keys = Object.keys(insert?.payload ?? {});
    expect(keys).not.toContain("odds");
    expect(keys).not.toContain("bookmaker");
  });
});
