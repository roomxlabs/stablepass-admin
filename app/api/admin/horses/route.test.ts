import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();
vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));

import { POST } from "./route";

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}
function asNonAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: false } } };
}
function postReq(body: unknown): Request {
  return new Request("http://t/api/admin/horses", { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("POST /api/admin/horses — create", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await POST(postReq({ trainerId: "t1" }));
    expect(r.status).toBe(403);
  });

  it("creates a horse -> 201", async () => {
    asAdmin();
    state.tables.horse = { mutate: { single: { id: "h1", display_name: "Mahogany" } } };
    const r = await POST(
      postReq({
        trainerId: "t1",
        stableName: "Mahogany",
        sire: "Snitzel",
        dam: "Polar Success",
        sex: "gelding",
        colour: "Bay",
        foalingYear: 2020,
        trainingStatus: "racing",
        status: "active",
        starts: 24,
        wins: 6,
        places: 9,
        prizeMoneyCents: 1200000,
      }),
    );
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.data.id).toBe("h1");
    expect(j.data.display_name).toBe("Mahogany");
  });

  it("400 when trainerId is missing", async () => {
    asAdmin();
    const r = await POST(postReq({ sire: "Snitzel" }));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
  });
});
