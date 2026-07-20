import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));

import { PATCH } from "./route";

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}
function asNonAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: false } } };
}
function patchReq(body: unknown): Request {
  return new Request("http://t/api/admin/racing-matches/p1", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}
const ctx = () => ({ params: Promise.resolve({ id: "p1" }) });

/** A pending proposal linking horse h1 to feed id RA-991. */
function pendingProposal() {
  state.tables.horse_match_proposal = {
    select: { single: { id: "p1", horse_id: "h1", racing_api_id: "RA-991", status: "pending" } },
    mutate: { single: { id: "p1", status: "confirmed", resolved_at: "2026-07-21T00:00:00.000Z" } },
  };
}
const horseUpdates = () =>
  state.calls.mutations.filter((m) => m.table === "horse" && m.op === "update");
const proposalUpdates = () =>
  state.calls.mutations.filter((m) => m.table === "horse_match_proposal" && m.op === "update");

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("PATCH /api/admin/racing-matches/:id", () => {
  it("401s with no session (guardrail)", async () => {
    state.user = null;
    const r = await PATCH(patchReq({ action: "confirm" }), ctx());
    expect(r.status).toBe(401);
  });

  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await PATCH(patchReq({ action: "confirm" }), ctx());
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("forbidden");
  });

  it("403s for a non-admin BEFORE writing anything (guardrail)", async () => {
    asNonAdmin();
    pendingProposal();
    await PATCH(patchReq({ action: "confirm" }), ctx());
    expect(state.calls.mutations).toEqual([]);
  });

  it("400s on an unknown action", async () => {
    asAdmin();
    const r = await PATCH(patchReq({ action: "maybe" }), ctx());
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("validation_failed");
    expect(state.calls.mutations).toEqual([]);
  });

  it("404s when the proposal does not exist", async () => {
    asAdmin();
    state.tables.horse_match_proposal = { select: { single: null } };
    const r = await PATCH(patchReq({ action: "confirm" }), ctx());
    expect(r.status).toBe(404);
  });

  it("confirm links the horse to the feed id and resolves the proposal", async () => {
    asAdmin();
    pendingProposal();
    state.tables.horse = {
      select: { single: { id: "h1", racing_api_id: null } },
      mutate: { single: { id: "h1" } },
    };

    const r = await PATCH(patchReq({ action: "confirm" }), ctx());
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.status).toBe("confirmed");
    expect(j.data.horseId).toBe("h1");

    // The acceptance criterion: the horse actually got the feed id written.
    expect(horseUpdates()).toHaveLength(1);
    expect(horseUpdates()[0].values).toEqual({ racing_api_id: "RA-991" });
    expect(proposalUpdates()[0].values.status).toBe("confirmed");
    expect(proposalUpdates()[0].values.resolved_at).toEqual(expect.any(String));
  });

  it("confirm on a horse already linked to a DIFFERENT id 409s and writes nothing", async () => {
    asAdmin();
    pendingProposal();
    state.tables.horse = { select: { single: { id: "h1", racing_api_id: "RA-000" } } };

    const r = await PATCH(patchReq({ action: "confirm" }), ctx());
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("already_linked");
    // No overwrite, and the proposal stays pending for a human to re-judge.
    expect(state.calls.mutations).toEqual([]);
  });

  it("confirm on a horse already linked to the SAME id is idempotent", async () => {
    asAdmin();
    pendingProposal();
    state.tables.horse = { select: { single: { id: "h1", racing_api_id: "RA-991" } } };

    const r = await PATCH(patchReq({ action: "confirm" }), ctx());
    expect(r.status).toBe(200);
    expect(horseUpdates()).toEqual([]);
    expect(proposalUpdates()).toHaveLength(1);
  });

  it("reject resolves the proposal without touching the horse", async () => {
    asAdmin();
    state.tables.horse_match_proposal = {
      select: { single: { id: "p1", horse_id: "h1", racing_api_id: "RA-991", status: "pending" } },
      mutate: { single: { id: "p1", status: "rejected", resolved_at: "2026-07-21T00:00:00.000Z" } },
    };

    const r = await PATCH(patchReq({ action: "reject" }), ctx());
    expect(r.status).toBe(200);
    expect((await r.json()).data.status).toBe("rejected");
    expect(horseUpdates()).toEqual([]);
    expect(proposalUpdates()[0].values.status).toBe("rejected");
    expect(proposalUpdates()[0].values.resolved_at).toEqual(expect.any(String));
  });

  it("scopes both writes to the still-pending row (compare-and-swap)", async () => {
    asAdmin();
    pendingProposal();
    state.tables.horse = {
      select: { single: { id: "h1", racing_api_id: null } },
      mutate: { single: { id: "h1" } },
    };
    await PATCH(patchReq({ action: "confirm" }), ctx());

    // The horse link must be conditional on it still being unlinked...
    expect(state.calls.filters).toContainEqual({
      table: "horse",
      op: "is",
      column: "racing_api_id",
      value: null,
    });
    // ...and the proposal resolve conditional on it still being pending.
    expect(state.calls.filters).toContainEqual({
      table: "horse_match_proposal",
      op: "eq",
      column: "status",
      value: "pending",
    });
  });

  it("409s when another confirm links the horse first (lost the race, no overwrite)", async () => {
    asAdmin();
    pendingProposal();
    state.tables.horse = {
      select: { single: { id: "h1", racing_api_id: null } },
      // The compare-and-swap matched zero rows: someone linked it in between.
      mutate: { single: null },
    };

    const r = await PATCH(patchReq({ action: "confirm" }), ctx());
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("already_linked");
    // The proposal must NOT have been marked confirmed on a failed link.
    expect(proposalUpdates()).toEqual([]);
  });

  it("409s when another tab resolves the proposal first", async () => {
    asAdmin();
    state.tables.horse_match_proposal = {
      select: { single: { id: "p1", horse_id: "h1", racing_api_id: "RA-991", status: "pending" } },
      mutate: { single: null },
    };

    const r = await PATCH(patchReq({ action: "reject" }), ctx());
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("invalid_status");
  });

  it("a resolved proposal stays resolved — re-resolving 409s", async () => {
    asAdmin();
    for (const status of ["confirmed", "rejected"]) {
      Object.assign(state, blankState());
      asAdmin();
      state.tables.horse_match_proposal = {
        select: { single: { id: "p1", horse_id: "h1", racing_api_id: "RA-991", status } },
      };
      const r = await PATCH(patchReq({ action: "confirm" }), ctx());
      expect(r.status).toBe(409);
      expect((await r.json()).error.code).toBe("invalid_status");
      expect(state.calls.mutations).toEqual([]);
    }
  });
});
