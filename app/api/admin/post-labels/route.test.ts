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
function postReq(body: unknown): Request {
  return new Request("http://t/api/admin/post-labels", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** A `post_label` row as be's ENG-978 migration shapes it. */
function row(name: string, over: Partial<{ id: string; is_builtin: boolean; sort_order: number }> = {}) {
  return { id: over.id ?? `l-${name}`, name, is_builtin: over.is_builtin ?? false, sort_order: over.sort_order ?? 0 };
}

/** Script the table's contents. The fake does not filter, so reads return this set verbatim. */
function labels(rows: ReturnType<typeof row>[]) {
  state.tables.post_label = { select: { rows } };
}

beforeEach(() => {
  Object.assign(state, blankState());
});

// ---------------------------------------------------------------------------
// Guardrail 1 — every admin route requires is_admin AND an AAL2 session.
// ---------------------------------------------------------------------------
describe("GET/POST /api/admin/post-labels — the admin gate", () => {
  it("403s the LIST for a non-admin", async () => {
    asNonAdmin();
    const r = await GET();
    expect(r.status).toBe(403);
  });

  it("403s CREATE for a non-admin, and never writes", async () => {
    asNonAdmin();
    const r = await POST(postReq({ name: "Owner Update" }));
    expect(r.status).toBe(403);
    expect(state.calls.mutations).toHaveLength(0);
  });

  it("401s with no session at all", async () => {
    state.user = null;
    const r = await POST(postReq({ name: "Owner Update" }));
    expect(r.status).toBe(401);
    expect(state.calls.mutations).toHaveLength(0);
  });

  // The fake defaults to aal2, so this MUST opt in explicitly or it silently
  // asserts the passing branch (.rx/gotchas.md).
  it("403s mfa_required for an AAL1 admin on LIST — writing the label vocabulary needs AAL2", async () => {
    asAdmin();
    state.aal = "aal1";
    const r = await GET();
    expect(r.status).toBe(403);
    const j = await r.json();
    expect(j.error.code).toBe("mfa_required");
  });

  it("403s mfa_required for an AAL1 admin on CREATE, and never writes", async () => {
    asAdmin();
    state.aal = "aal1";
    const r = await POST(postReq({ name: "Owner Update" }));
    expect(r.status).toBe(403);
    const j = await r.json();
    expect(j.error.code).toBe("mfa_required");
    expect(state.calls.mutations).toHaveLength(0);
  });
});

describe("GET /api/admin/post-labels — the picker's live list", () => {
  it("returns the rows for an admin", async () => {
    asAdmin();
    labels([row("Trackwork", { is_builtin: true, sort_order: 3 })]);
    const r = await GET();
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data).toHaveLength(1);
    expect(j.data[0].name).toBe("Trackwork");
  });

  // The ordering rule, and why it is not just `order("sort_order")`: every
  // admin-added row defaults to sort_order 0, so sorting on that column alone
  // would collate new labels AHEAD of the builtins in insertion order.
  it("orders builtins first by sort_order, then admin-added ones alphabetically", async () => {
    asAdmin();
    labels([
      row("Zebra Update"),
      row("Trial", { is_builtin: true, sort_order: 5 }),
      row("Owner Update"),
      row("Stable Update", { is_builtin: true, sort_order: 1 }),
    ]);
    const r = await GET();
    const j = await r.json();
    expect(j.data.map((l: { name: string }) => l.name)).toEqual([
      "Stable Update",
      "Trial",
      "Owner Update",
      "Zebra Update",
    ]);
  });

  it("surfaces a failed read as a 400 rather than an empty list", async () => {
    // An empty picker and a broken read look identical in the UI, and an
    // operator who sees no categories ships an unlabelled post.
    asAdmin();
    state.tables.post_label = { select: { error: { code: "42501", message: "permission denied" } } };
    const r = await GET();
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("query_failed");
    // The ticket's contract: no Postgres error.message reaches a response body.
    expect(JSON.stringify(j)).not.toContain("permission denied");
  });
});

describe("POST /api/admin/post-labels — Postgres errors stay out of the body", () => {
  it("does not leak the Postgres message of a failed INSERT into the response", async () => {
    asAdmin();
    state.tables.post_label = {
      select: { rows: [] },
      mutate: { error: { code: "42501", message: "permission denied for table post_label" } },
    };
    const r = await POST(postReq({ name: "Owner Update" }));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("insert_failed");
    expect(JSON.stringify(j)).not.toContain("permission denied");
  });

  it("does not leak the Postgres message of a failed duplicate-check READ", async () => {
    // The third site: the existence read that runs BEFORE the insert. Scripting
    // an error here (rather than rows) stops the route short of the insert
    // branch, so this is the only case that exercises it.
    asAdmin();
    state.tables.post_label = {
      select: { error: { code: "42501", message: "permission denied for table post_label" } },
    };
    const r = await POST(postReq({ name: "Owner Update" }));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("query_failed");
    expect(JSON.stringify(j)).not.toContain("permission denied");
    expect(state.calls.mutations).toHaveLength(0);
  });
});

describe("POST /api/admin/post-labels — Add-new", () => {
  it("creates a label and returns it (201)", async () => {
    asAdmin();
    labels([]);
    state.tables.post_label = {
      select: { rows: [] },
      mutate: { single: row("Owner Update", { id: "l1" }) },
    };
    const r = await POST(postReq({ name: "Owner Update" }));
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.data.name).toBe("Owner Update");
    const insert = state.calls.mutations.find((m) => m.table === "post_label" && m.op === "insert");
    // Never seeds a builtin: those are pinned immutable in the database and
    // are be's to define, not admin's to mint.
    expect(insert?.payload).toMatchObject({ name: "Owner Update", is_builtin: false });
  });

  it("trims surrounding whitespace before storing", async () => {
    // `post_label_name_not_blank` requires `name = btrim(name)`, so an
    // untrimmed insert would be refused by Postgres for a reason no operator
    // could see.
    asAdmin();
    state.tables.post_label = {
      select: { rows: [] },
      mutate: { single: row("Owner Update", { id: "l1" }) },
    };
    await POST(postReq({ name: "  Owner Update  " }));
    const insert = state.calls.mutations.find((m) => m.table === "post_label" && m.op === "insert");
    expect(insert?.payload).toMatchObject({ name: "Owner Update" });
  });

  // -------------------------------------------------------------------------
  // The duplicate rule. `post_label.name` is unique but BYTE-EXACT, so without
  // this the table would happily hold "Trackwork" and "trackwork" as two
  // separate categories — the exact mess the ticket names.
  // -------------------------------------------------------------------------
  it("a duplicate differing only by CASE returns the existing row and inserts nothing", async () => {
    asAdmin();
    labels([row("Trackwork", { id: "l-existing", is_builtin: true, sort_order: 3 })]);
    const r = await POST(postReq({ name: "trackwork" }));
    expect(r.status).toBe(200);
    const j = await r.json();
    // The CANONICAL spelling comes back, not what was typed — that is the
    // value `post.label`'s foreign key will accept.
    expect(j.data.name).toBe("Trackwork");
    expect(j.data.id).toBe("l-existing");
    expect(state.calls.mutations).toHaveLength(0);
  });

  // ENG-1267 — the duplicate lookup now reads `retired_at` (it has to, to tell
  // a retired row from a live one), and that column must NOT reach the
  // response body: compose's picker renders these rows verbatim. Asserted as a
  // WHOLE object on purpose — the field-by-field assertions above stay green
  // with an extra key leaking through, which is exactly how a shape regression
  // ships unnoticed.
  it("a LIVE duplicate's body carries no retired_at, though the lookup read selects it", async () => {
    asAdmin();
    state.tables.post_label = {
      select: {
        rows: [
          { id: "l-existing", name: "Trackwork", is_builtin: true, sort_order: 3, retired_at: null },
        ],
      },
    };
    const r = await POST(postReq({ name: "trackwork" }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      data: { id: "l-existing", name: "Trackwork", is_builtin: true, sort_order: 3 },
    });
    expect(state.calls.mutations).toHaveLength(0);
  });

  it("a duplicate differing only by TRAILING SPACE returns the existing row", async () => {
    asAdmin();
    labels([row("Trackwork", { id: "l-existing" })]);
    const r = await POST(postReq({ name: "Trackwork   " }));
    expect(r.status).toBe(200);
    expect((await r.json()).data.id).toBe("l-existing");
    expect(state.calls.mutations).toHaveLength(0);
  });

  it("a duplicate differing by case AND spacing together still returns the existing row", async () => {
    asAdmin();
    labels([row("Race Day · Today", { id: "l-raceday" })]);
    const r = await POST(postReq({ name: "  race day · today  " }));
    expect(r.status).toBe(200);
    expect((await r.json()).data.id).toBe("l-raceday");
    expect(state.calls.mutations).toHaveLength(0);
  });

  it("collapses INNER whitespace too — 'Race  Day' is not a second category", async () => {
    asAdmin();
    labels([row("Race Day", { id: "l-rd" })]);
    const r = await POST(postReq({ name: "Race  Day" }));
    expect(r.status).toBe(200);
    expect((await r.json()).data.id).toBe("l-rd");
    expect(state.calls.mutations).toHaveLength(0);
  });

  it("a genuinely different name is NOT treated as a duplicate", async () => {
    // The other side of the fold: over-eager matching would silently hand back
    // the wrong category and quietly mislabel the post.
    asAdmin();
    state.tables.post_label = {
      select: { rows: [row("Trackwork", { id: "l-existing" })] },
      mutate: { single: row("Trackwork Extras", { id: "l2" }) },
    };
    const r = await POST(postReq({ name: "Trackwork Extras" }));
    expect(r.status).toBe(201);
    expect(state.calls.mutations).toHaveLength(1);
  });

  it("losing a race to a concurrent identical insert (23505) returns the winner, not an error", async () => {
    asAdmin();
    // The pre-check saw nothing; the unique index caught it at insert time.
    // A second read then finds the row the other request created.
    let reads = 0;
    Object.defineProperty(state.tables, "post_label", {
      configurable: true,
      get() {
        reads += 1;
        return {
          select: { rows: reads > 1 ? [row("Owner Update", { id: "l-winner" })] : [] },
          mutate: { error: { code: "23505", message: "duplicate key value violates unique constraint" } },
        };
      },
    });
    const r = await POST(postReq({ name: "Owner Update" }));
    expect(r.status).toBe(200);
    expect((await r.json()).data.id).toBe("l-winner");
  });

  // -------------------------------------------------------------------------
  // Guardrail 6 — no betting / bookmaker anything.
  //
  // This is the PREVENTIVE control. be's ENG-978 migration states plainly that
  // it could not ship a DB-level denylist and left only a detective CI grep
  // (ENG-994 tracks that gap). This route is the only way a `post_label` row
  // gets authored, so it is where the check has to bite.
  // -------------------------------------------------------------------------
  it.each(["Betting Tips", "Best Odds", "Bookmaker Corner", "Tipping Update", "Punting Notes"])(
    "refuses a gambling-flavoured label (%s) and never writes",
    async (name) => {
      asAdmin();
      labels([]);
      const r = await POST(postReq({ name }));
      expect(r.status).toBe(400);
      const j = await r.json();
      expect(j.error.code).toBe("validation_failed");
      expect(state.calls.mutations).toHaveLength(0);
      // The message names the RULE, never the matched token — echoing the word
      // back is how a denylist teaches people to route around it.
      expect(j.error.message.toLowerCase()).not.toContain(name.toLowerCase());
    },
  );

  // The review bypass table, at the ROUTE boundary — not just on the helper.
  // This route is the only place a `post_label` row is authored, so these are
  // the cases that decide whether a gambling-flavoured category can exist.
  it.each([
    "Bookmakers",
    "Tipsters",
    "Punters",
    "Bettor",
    "Bookmaking",
    "Multibet",
    "Trifecta",
    "\uff42\uff45\uff54\uff54\uff49\uff4e\uff47",
    "bett\u200bing",
  ])("refuses the guardrail-6 near-miss %s and never writes", async (name) => {
    asAdmin();
    labels([]);
    const r = await POST(postReq({ name }));
    expect(r.status).toBe(400);
    expect(state.calls.mutations).toHaveLength(0);
  });

  it("refuses the picker's Add-new sentinel as a stored name", async () => {
    // It trips no other rule, but a row with this name would render a second
    // <option> that re-opens the Add-new field instead of selecting it.
    asAdmin();
    labels([]);
    const r = await POST(postReq({ name: "__stablepass_add_new_label__" }));
    expect(r.status).toBe(400);
    expect(state.calls.mutations).toHaveLength(0);
  });

  it("a fullwidth spelling folds onto the existing row rather than creating a twin", async () => {
    asAdmin();
    labels([row("Trackwork", { id: "l-existing" })]);
    const r = await POST(postReq({ name: "\uff34rackwork" }));
    expect(r.status).toBe(200);
    expect((await r.json()).data.id).toBe("l-existing");
    expect(state.calls.mutations).toHaveLength(0);
  });

  it("does not refuse ordinary racing vocabulary that merely CONTAINS a banned substring", async () => {
    // Word-boundary anchored, so "Trackwork" survives despite containing no
    // banned token, and a word like "Marketing" does not trip on "market".
    asAdmin();
    state.tables.post_label = {
      select: { rows: [] },
      mutate: { single: row("Barrier Trial Debrief", { id: "l3" }) },
    };
    const r = await POST(postReq({ name: "Barrier Trial Debrief" }));
    expect(r.status).toBe(201);
  });

  it("400s a blank or whitespace-only name", async () => {
    asAdmin();
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
    const r = await POST(postReq({ name: "x".repeat(41) }));
    expect(r.status).toBe(400);
    expect(state.calls.mutations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Retire (ENG-1267) — un-retire on re-add. The GET-side exclusion of retired
// rows is asserted separately in route-retired.test.ts, which wraps the fake
// client in the call recorder; that wrapper is not applied to this file's
// existing mock so the pre-existing assertions above are undisturbed.
// ---------------------------------------------------------------------------
describe("POST /api/admin/post-labels — un-retire on re-add", () => {
  it("a duplicate whose only existing row is RETIRED is un-retired and returned as 200, not 201", async () => {
    asAdmin();
    const retired = row("Trackwork", { id: "l-existing", sort_order: 3 });
    (retired as { retired_at?: string | null }).retired_at = "2026-09-01T00:00:00.000Z";
    state.tables.post_label = {
      select: { rows: [retired] },
      mutate: { single: row("Trackwork", { id: "l-existing", sort_order: 3 }) },
    };
    const r = await POST(postReq({ name: "trackwork" }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.id).toBe("l-existing");
    expect(j.data.name).toBe("Trackwork");

    expect(state.calls.mutations).toHaveLength(1);
    const m = state.calls.mutations[0];
    expect(m).toMatchObject({ table: "post_label", op: "update" });
    expect(m.payload).toEqual({ retired_at: null });
    expect(m.filters).toEqual([{ column: "id", value: "l-existing" }]);
  });

  it("losing a race whose winner is RETIRED un-retires it and returns 200", async () => {
    asAdmin();
    let reads = 0;
    Object.defineProperty(state.tables, "post_label", {
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
        if (reads === 4) {
          const retired = row("Owner Update", { id: "l-winner" });
          (retired as { retired_at?: string | null }).retired_at = "2026-09-01T00:00:00.000Z";
          return { select: { rows: [retired] } };
        }
        return { mutate: { single: row("Owner Update", { id: "l-winner" }) } };
      },
    });
    const r = await POST(postReq({ name: "Owner Update" }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.id).toBe("l-winner");
  });
});

// ---------------------------------------------------------------------------
// Acceptance: add -> list -> re-add restores the same id.
//
// Deliberately NOT the retire safety net. This file drives GET/POST against a
// scripted fake that does no filtering, so a "list omits the retired row" step
// here would only assert what the script was told to return and would stay
// green with `.is("retired_at", null)` deleted. The retire exclusion is proven
// where it can be: the filter is asserted on the real call shape in
// `route-retired.test.ts`, and the retire mutation itself in
// `app/api/admin/post-labels/[id]/route.test.ts`.
// ---------------------------------------------------------------------------
describe("acceptance — add, list, re-add restores the same id", () => {
  it("walks add -> list -> re-add", async () => {
    asAdmin();

    // 1. Add.
    state.tables.post_label = {
      select: { rows: [] },
      mutate: { single: row("Owner Update", { id: "l-1" }) },
    };
    const createRes = await POST(postReq({ name: "Owner Update" }));
    expect(createRes.status).toBe(201);
    expect((await createRes.json()).data.id).toBe("l-1");

    // 2. List includes it.
    labels([row("Owner Update", { id: "l-1" })]);
    const listRes = await GET();
    expect((await listRes.json()).data.map((r: { id: string }) => r.id)).toContain("l-1");

    // 3. Re-add a retired row restores the SAME id (no twin is minted).
    const retired = row("Owner Update", { id: "l-1" });
    (retired as { retired_at?: string | null }).retired_at = "2026-09-20T00:00:00.000Z";
    state.tables.post_label = {
      select: { rows: [retired] },
      mutate: { single: row("Owner Update", { id: "l-1" }) },
    };
    const readdRes = await POST(postReq({ name: "Owner Update" }));
    expect(readdRes.status).toBe(200);
    expect((await readdRes.json()).data.id).toBe("l-1");
  });
});
