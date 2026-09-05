import { describe, it, expect, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";
import { listWaitlist, sanitize, emailsFor } from "./data";

// listWaitlist takes the sb client by injection, so results are driven per
// table through the shared Supabase fake — no module mock needed.
const state: FakeState = blankState();
const sb = () => makeFakeClient(state) as unknown as SupabaseClient;

const ROWS = [
  { id: "1", email: "b@example.com", source: "marketing", created_at: "2026-09-02T10:00:00Z" },
  { id: "2", email: "a@example.com", source: "marketing", created_at: "2026-09-01T10:00:00Z" },
];

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("listWaitlist", () => {
  it("maps rows and reports the total", async () => {
    state.tables.waitlist = { select: { rows: ROWS } };
    const { rows, total } = await listWaitlist(sb());

    expect(rows).toEqual([
      { id: "1", email: "b@example.com", source: "marketing", joinedAt: "2026-09-02T10:00:00Z" },
      { id: "2", email: "a@example.com", source: "marketing", joinedAt: "2026-09-01T10:00:00Z" },
    ]);
    expect(total).toBe(2);
  });

  it("reads the waitlist table, never a view or a wider table", async () => {
    state.tables.waitlist = { select: { rows: ROWS } };
    await listWaitlist(sb());
    // The addresses are admin-only; reading anything else here would be a new
    // surface to argue about, so the table this touches is pinned.
    expect([...new Set(state.calls.from)]).toEqual(["waitlist"]);
  });

  it("drops a row with no usable address rather than rendering a blank line", async () => {
    state.tables.waitlist = {
      select: { rows: [...ROWS, { id: "3", email: "   ", source: null, created_at: "2026-09-03T10:00:00Z" }] },
    };
    const { rows } = await listWaitlist(sb());
    expect(rows.map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("survives an empty table and a missing payload", async () => {
    state.tables.waitlist = { select: { rows: [] } };
    await expect(listWaitlist(sb())).resolves.toEqual({ rows: [], total: 0 });

    Object.assign(state, blankState());
    state.tables.waitlist = { select: { rows: undefined } };
    await expect(listWaitlist(sb())).resolves.toEqual({ rows: [], total: 0 });
  });

  it("trims the source to null when it is blank", async () => {
    state.tables.waitlist = {
      select: { rows: [{ id: "1", email: "a@example.com", source: "  ", created_at: null }] },
    };
    const { rows } = await listWaitlist(sb());
    expect(rows[0].source).toBeNull();
    expect(rows[0].joinedAt).toBeNull();
  });
});

describe("sanitize", () => {
  it("strips the characters PostgREST would read as operators", () => {
    // Left unsanitised, these change the SHAPE of the filter rather than being
    // matched literally.
    expect(sanitize("a,b(c)*d%e\\f")).toBe("a b c  d e f");
    expect(sanitize("  spaced  ")).toBe("spaced");
  });
});

describe("emailsFor", () => {
  it("joins the addresses for pasting into a BCC field", () => {
    expect(emailsFor([
      { id: "1", email: "a@example.com", source: null, joinedAt: null },
      { id: "2", email: "b@example.com", source: null, joinedAt: null },
    ])).toBe("a@example.com, b@example.com");
  });

  it("is empty for an empty list", () => {
    expect(emailsFor([])).toBe("");
  });
});
