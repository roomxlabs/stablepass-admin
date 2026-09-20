import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";
import { recordCalls, blankRecord, type CallRecord } from "@/lib/testing/call-recorder";

const state: FakeState = blankState();
let rec: CallRecord = blankRecord();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => recordCalls(makeFakeClient(state), rec),
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
function postReq(body: unknown): Request {
  return new Request("http://t/api/admin/post-bylines", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** A `post_byline` row. */
function row(name: string, over: Partial<{ id: string; sort_order: number; retired_at: string | null }> = {}) {
  return {
    id: over.id ?? `b-${name}`,
    name,
    sort_order: over.sort_order ?? 0,
    retired_at: over.retired_at ?? null,
  };
}

/** Script the table's contents. The fake does not filter, so reads return this set verbatim. */
function bylines(rows: ReturnType<typeof row>[]) {
  state.tables.post_byline = { select: { rows } };
}

beforeEach(() => {
  Object.assign(state, blankState());
  rec = blankRecord();
});

// ---------------------------------------------------------------------------
// Guardrail 1 — every admin route requires is_admin AND an AAL2 session.
// ---------------------------------------------------------------------------
describe("GET/POST /api/admin/post-bylines — the admin gate", () => {
  it("403s the LIST for a non-admin", async () => {
    asNonAdmin();
    const r = await GET();
    expect(r.status).toBe(403);
    expect(state.calls.mutations).toHaveLength(0);
  });

  it("403s CREATE for a non-admin, and never writes", async () => {
    asNonAdmin();
    const r = await POST(postReq({ name: "Trackwork Desk" }));
    expect(r.status).toBe(403);
    expect(state.calls.mutations).toHaveLength(0);
  });

  it("401s with no session at all", async () => {
    state.user = null;
    const r = await POST(postReq({ name: "Trackwork Desk" }));
    expect(r.status).toBe(401);
    expect(state.calls.mutations).toHaveLength(0);
  });

  it("401s LIST with no session at all", async () => {
    state.user = null;
    const r = await GET();
    expect(r.status).toBe(401);
    expect(state.calls.mutations).toHaveLength(0);
  });

  // The fake defaults to aal2, so this MUST opt in explicitly.
  it("403s mfa_required for an AAL1 admin on LIST — writing the byline vocabulary needs AAL2", async () => {
    asAdmin();
    state.aal = "aal1";
    const r = await GET();
    expect(r.status).toBe(403);
    const j = await r.json();
    expect(j.error.code).toBe("mfa_required");
    expect(state.calls.mutations).toHaveLength(0);
  });

  it("403s mfa_required for an AAL1 admin on CREATE, and never writes", async () => {
    asAdmin();
    state.aal = "aal1";
    const r = await POST(postReq({ name: "Trackwork Desk" }));
    expect(r.status).toBe(403);
    const j = await r.json();
    expect(j.error.code).toBe("mfa_required");
    expect(state.calls.mutations).toHaveLength(0);
  });
});

describe("GET /api/admin/post-bylines — the picker's live list", () => {
  it("returns the rows for an admin", async () => {
    asAdmin();
    bylines([row("Trackwork Desk", { sort_order: 3 })]);
    const r = await GET();
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data).toHaveLength(1);
    expect(j.data[0]).toEqual({ id: "b-Trackwork Desk", name: "Trackwork Desk", sortOrder: 3 });
  });

  it("orders by sort_order, then name", async () => {
    asAdmin();
    bylines([
      row("Zebra Desk", { sort_order: 1 }),
      row("Alpha Desk", { sort_order: 0 }),
      row("Mid Desk", { sort_order: 0 }),
    ]);
    const r = await GET();
    const j = await r.json();
    expect(j.data.map((l: { name: string }) => l.name)).toEqual(["Alpha Desk", "Mid Desk", "Zebra Desk"]);
  });

  it("surfaces a failed read as a 400 rather than an empty list", async () => {
    asAdmin();
    state.tables.post_byline = { select: { error: { code: "42501", message: "permission denied" } } };
    const r = await GET();
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("query_failed");
  });

  // Retired exclusion (ENG-1267) — proven via the recorder, since the fake
  // itself applies no filtering to what it returns.
  it("reads with .is(retired_at, null) so retired bylines are excluded", async () => {
    asAdmin();
    bylines([row("Trackwork Desk")]);
    await GET();
    expect(rec.filters).toContain("post_byline.retired_at is null");
  });
});

describe("POST /api/admin/post-bylines — Add-new", () => {
  it("creates a byline and returns it (201)", async () => {
    asAdmin();
    state.tables.post_byline = {
      select: { rows: [] },
      mutate: { single: row("Owner Desk", { id: "b1" }) },
    };
    const r = await POST(postReq({ name: "Owner Desk" }));
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.data).toEqual({ id: "b1", name: "Owner Desk", sortOrder: 0 });
    const insert = state.calls.mutations.find((m) => m.table === "post_byline" && m.op === "insert");
    expect(insert?.payload).toMatchObject({ name: "Owner Desk", sort_order: 0 });
  });

  it("trims surrounding whitespace before storing", async () => {
    asAdmin();
    state.tables.post_byline = {
      select: { rows: [] },
      mutate: { single: row("Owner Desk", { id: "b1" }) },
    };
    await POST(postReq({ name: "  Owner Desk  " }));
    const insert = state.calls.mutations.find((m) => m.table === "post_byline" && m.op === "insert");
    expect(insert?.payload).toMatchObject({ name: "Owner Desk" });
  });

  // -------------------------------------------------------------------------
  // Contract difference from post-labels: a live duplicate is a 409 here.
  // -------------------------------------------------------------------------
  it("409s byline_exists for a live duplicate differing only by case, and never writes", async () => {
    asAdmin();
    bylines([row("Trackwork Desk", { id: "b-existing" })]);
    const r = await POST(postReq({ name: "trackwork desk" }));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error.code).toBe("byline_exists");
    expect(state.calls.mutations).toHaveLength(0);
  });

  it("409s byline_exists for a live duplicate differing only by spacing", async () => {
    asAdmin();
    bylines([row("Trackwork Desk", { id: "b-existing" })]);
    const r = await POST(postReq({ name: "Trackwork   Desk" }));
    expect(r.status).toBe(409);
    expect(state.calls.mutations).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Un-retire on re-add.
  // -------------------------------------------------------------------------
  it("un-retires a retired duplicate and returns it with 200, not 201", async () => {
    asAdmin();
    bylines([row("Trackwork Desk", { id: "b-existing", retired_at: "2026-09-01T00:00:00.000Z" })]);
    state.tables.post_byline = {
      select: { rows: [row("Trackwork Desk", { id: "b-existing", retired_at: "2026-09-01T00:00:00.000Z" })] },
      mutate: { single: row("Trackwork Desk", { id: "b-existing", retired_at: null }) },
    };
    const r = await POST(postReq({ name: "trackwork desk" }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data).toEqual({ id: "b-existing", name: "Trackwork Desk", sortOrder: 0 });

    expect(state.calls.mutations).toHaveLength(1);
    const m = state.calls.mutations[0];
    expect(m).toMatchObject({ table: "post_byline", op: "update" });
    expect(m.payload).toEqual({ retired_at: null });
    expect(m.filters).toEqual([{ column: "id", value: "b-existing" }]);
  });

  it("surfaces a failed un-retire update as a 400", async () => {
    asAdmin();
    state.tables.post_byline = {
      select: { rows: [row("Trackwork Desk", { id: "b-existing", retired_at: "2026-09-01T00:00:00.000Z" })] },
      mutate: { error: { code: "42501", message: "permission denied" } },
    };
    const r = await POST(postReq({ name: "Trackwork Desk" }));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("update_failed");
  });

  it("losing a race to a concurrent identical insert (23505) returns the live winner as a 409", async () => {
    asAdmin();
    let reads = 0;
    Object.defineProperty(state.tables, "post_byline", {
      configurable: true,
      get() {
        reads += 1;
        return {
          select: { rows: reads > 1 ? [row("Owner Desk", { id: "b-winner" })] : [] },
          mutate: { error: { code: "23505", message: "duplicate key value violates unique constraint" } },
        };
      },
    });
    const r = await POST(postReq({ name: "Owner Desk" }));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error.code).toBe("byline_exists");
  });

  it("losing a race to a concurrent insert whose winner is RETIRED un-retires it and returns 200", async () => {
    asAdmin();
    let reads = 0;
    Object.defineProperty(state.tables, "post_byline", {
      configurable: true,
      get() {
        reads += 1;
        // The fake's `.single()` reads the script TWICE per call (once for
        // `.single`, once for `.error`), so this route's retired-winner-race
        // path fires the getter 6 times: 1 (existence, awaited plain) + 2
        // (the failed insert's `.single()`) + 1 (the re-read, awaited plain)
        // + 2 (the un-retire update's `.single()`).
        if (reads === 1) return { select: { rows: [] } };
        if (reads === 2 || reads === 3)
          return { mutate: { error: { code: "23505", message: "duplicate key value violates unique constraint" } } };
        if (reads === 4)
          return { select: { rows: [row("Owner Desk", { id: "b-winner", retired_at: "2026-09-01T00:00:00.000Z" })] } };
        return { mutate: { single: row("Owner Desk", { id: "b-winner", retired_at: null }) } };
      },
    });
    const r = await POST(postReq({ name: "Owner Desk" }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.id).toBe("b-winner");
  });

  it("losing a race whose re-read finds no winner returns byline_exists 409", async () => {
    asAdmin();
    state.tables.post_byline = {
      select: { rows: [] },
      mutate: { error: { code: "23505", message: "duplicate key value violates unique constraint" } },
    };
    const r = await POST(postReq({ name: "Owner Desk" }));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error.code).toBe("byline_exists");
  });

  it("surfaces a non-23505 insert failure as insert_failed", async () => {
    asAdmin();
    state.tables.post_byline = {
      select: { rows: [] },
      mutate: { error: { code: "42501", message: "permission denied" } },
    };
    const r = await POST(postReq({ name: "Owner Desk" }));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("insert_failed");
  });

  // -------------------------------------------------------------------------
  // Guardrail 6 — no betting / bookmaker anything.
  // -------------------------------------------------------------------------
  it("refuses a banned byline name and never writes", async () => {
    asAdmin();
    bylines([]);
    const r = await POST(postReq({ name: "Betting Desk" }));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
    expect(state.calls.mutations).toHaveLength(0);
  });

  it("400s a blank or whitespace-only name", async () => {
    for (const name of ["", "   "]) {
      Object.assign(state, blankState());
      asAdmin();
      const r = await POST(postReq({ name }));
      expect(r.status).toBe(400);
      expect(state.calls.mutations).toHaveLength(0);
    }
  });

  it("400s a missing or non-string name", async () => {
    asAdmin();
    const r = await POST(postReq({ name: 42 }));
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("validation_failed");
  });

  it("400s an over-long name", async () => {
    asAdmin();
    const r = await POST(postReq({ name: "x".repeat(61) }));
    expect(r.status).toBe(400);
    expect(state.calls.mutations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Acceptance: add -> list -> re-add restores the same id.
//
// Deliberately NOT the retire safety net. This file drives GET/POST against a
// scripted fake that does no filtering, so a "list omits the retired row" step
// here would only assert what the script was told to return and would stay
// green with `.is("retired_at", null)` deleted. The retire exclusion is proven
// where it can be: the filter is asserted on the real call shape by this file's
// "reads with .is(retired_at, null) so retired bylines are excluded" case, and
// the retire mutation itself in `app/api/admin/post-bylines/[id]/route.test.ts`.
// ---------------------------------------------------------------------------
describe("acceptance — add, list, re-add restores the same id", () => {
  it("walks add -> list -> re-add", async () => {
    asAdmin();

    // 1. Add.
    state.tables.post_byline = {
      select: { rows: [] },
      mutate: { single: row("Trackwork Desk", { id: "b-1" }) },
    };
    const createRes = await POST(postReq({ name: "Trackwork Desk" }));
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()).data;
    expect(created.id).toBe("b-1");

    // 2. List includes it.
    bylines([row("Trackwork Desk", { id: "b-1" })]);
    const listRes = await GET();
    expect((await listRes.json()).data.map((r: { id: string }) => r.id)).toContain("b-1");

    // 3. Re-add a retired row restores the SAME id (no twin is minted).
    state.tables.post_byline = {
      select: { rows: [row("Trackwork Desk", { id: "b-1", retired_at: "2026-09-20T00:00:00.000Z" })] },
      mutate: { single: row("Trackwork Desk", { id: "b-1", retired_at: null }) },
    };
    const readdRes = await POST(postReq({ name: "Trackwork Desk" }));
    expect(readdRes.status).toBe(200);
    expect((await readdRes.json()).data.id).toBe("b-1");
  });
});
