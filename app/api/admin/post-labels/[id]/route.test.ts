import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));

import { DELETE } from "./route";

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}
function asNonAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: false } } };
}
function req(): Request {
  return new Request("http://t/api/admin/post-labels/l-1", { method: "DELETE" });
}
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}
function row(
  name: string,
  over: Partial<{ id: string; is_builtin: boolean; sort_order: number; retired_at: string | null }> = {},
) {
  return {
    id: over.id ?? "l-1",
    name,
    is_builtin: over.is_builtin ?? false,
    sort_order: over.sort_order ?? 0,
    retired_at: over.retired_at ?? null,
  };
}

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("DELETE /api/admin/post-labels/:id — the admin gate", () => {
  it("403s for a non-admin, and never writes", async () => {
    asNonAdmin();
    const r = await DELETE(req(), ctx("l-1"));
    expect(r.status).toBe(403);
    expect(state.calls.mutations).toHaveLength(0);
  });

  it("401s with no session at all", async () => {
    state.user = null;
    const r = await DELETE(req(), ctx("l-1"));
    expect(r.status).toBe(401);
    expect(state.calls.mutations).toHaveLength(0);
  });

  it("403s mfa_required for an AAL1 admin, and never writes", async () => {
    asAdmin();
    state.aal = "aal1";
    const r = await DELETE(req(), ctx("l-1"));
    expect(r.status).toBe(403);
    const j = await r.json();
    expect(j.error.code).toBe("mfa_required");
    expect(state.calls.mutations).toHaveLength(0);
  });
});

describe("DELETE /api/admin/post-labels/:id — retire", () => {
  it("retires a live, non-builtin label: 200, and the mutation is pinned to that row only", async () => {
    asAdmin();
    state.tables.post_label = {
      select: { single: row("Owner Update", { id: "l-1" }) },
      mutate: { single: row("Owner Update", { id: "l-1", retired_at: "2026-09-20T00:00:00.000Z" }) },
    };
    const r = await DELETE(req(), ctx("l-1"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data).toEqual({ id: "l-1", retired: true });

    expect(state.calls.mutations).toHaveLength(1);
    const m = state.calls.mutations[0];
    expect(m).toMatchObject({ table: "post_label", op: "update" });
    expect(Object.keys(m.payload)).toEqual(["retired_at"]);
    expect(typeof m.payload.retired_at).toBe("string");
    expect(m.filters).toEqual([{ column: "id", value: "l-1" }]);
  });

  it("404s when the row does not exist, and never writes", async () => {
    asAdmin();
    state.tables.post_label = { select: { single: null } };
    const r = await DELETE(req(), ctx("nope"));
    expect(r.status).toBe(404);
    const j = await r.json();
    expect(j.error.code).toBe("not_found");
    expect(state.calls.mutations).toHaveLength(0);
  });

  it("is idempotent: an already-retired row returns 200 with NO mutation", async () => {
    asAdmin();
    state.tables.post_label = {
      select: { single: row("Owner Update", { id: "l-1", retired_at: "2026-09-01T00:00:00.000Z" }) },
    };
    const r = await DELETE(req(), ctx("l-1"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data).toEqual({ id: "l-1", retired: true });
    expect(state.calls.mutations).toHaveLength(0);
  });

  it("surfaces a failed read as a 400", async () => {
    asAdmin();
    state.tables.post_label = { select: { error: { code: "42501", message: "permission denied" } } };
    const r = await DELETE(req(), ctx("l-1"));
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("query_failed");
    expect(state.calls.mutations).toHaveLength(0);
  });

  it("surfaces a failed update as a 400", async () => {
    asAdmin();
    state.tables.post_label = {
      select: { single: row("Owner Update", { id: "l-1" }) },
      mutate: { error: { code: "42501", message: "permission denied" } },
    };
    const r = await DELETE(req(), ctx("l-1"));
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("update_failed");
  });

  // -------------------------------------------------------------------------
  // builtin_label — a builtin label can never be retired.
  // -------------------------------------------------------------------------
  it("409s builtin_label for a builtin label, and NEVER touches the row", async () => {
    asAdmin();
    state.tables.post_label = {
      select: { single: row("Stable Update", { id: "l-1", is_builtin: true, sort_order: 1 }) },
    };
    const r = await DELETE(req(), ctx("l-1"));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error.code).toBe("builtin_label");
    expect(state.calls.mutations).toHaveLength(0);
  });

  it("409s builtin_label when the DB trigger refuses the update (23514) even though our read saw non-builtin", async () => {
    // Defence in depth: the row's is_builtin flipped under us between the read
    // and the write.
    asAdmin();
    state.tables.post_label = {
      select: { single: row("Owner Update", { id: "l-1", is_builtin: false }) },
      mutate: { error: { code: "23514", message: "new row violates check constraint post_label_pin_builtin" } },
    };
    const r = await DELETE(req(), ctx("l-1"));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error.code).toBe("builtin_label");
  });
});
