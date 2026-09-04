import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

// Swappable so one test can substitute a client whose `.range()` actually
// slices (the shared fake's is a no-op, which cannot test a paging loop).
let supabaseServerImpl: (() => Promise<unknown>) | null = null;
vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => (supabaseServerImpl ? supabaseServerImpl() : makeFakeClient(state)),
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
type DbRow = { id: string; email: string; source: string | null; created_at: string };

/**
 * Installs a Supabase stand-in that ACTUALLY honours `.range(from,to)`, as an
 * authenticated AAL2 admin.
 *
 * The shared fake's `.range()` is a no-op that replays the same rows for every
 * call. That is fine for a single-shot read, but `fetchAllWaitlist` pages until
 * it gets an empty batch — against the no-op fake it never does, so any export
 * test that scripts rows through the shared fake would loop to the safety cap.
 * Honouring the window is also the only way to prove the loop pages at all.
 */
function useRows(all: DbRow[]) {
  supabaseServerImpl = async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: "aal2", nextLevel: "aal2", currentAuthenticationMethods: [] },
          error: null,
        }),
      },
    },
    from: (table: string) => {
      const b: Record<string, unknown> = {
        select: () => b,
        order: () => b,
        ilike: () => b,
        eq: () => b,
        single: async () => ({ data: { is_admin: true }, error: null }),
        range: async (from: number, to: number) => ({
          data: table === "waitlist" ? all.slice(from, to + 1) : [],
          error: null,
          count: all.length,
        }),
      };
      return b;
    },
  });
}

function req(qs = ""): Request {
  return new Request(`http://t/api/admin/waitlist/export${qs}`);
}

beforeEach(() => {
  Object.assign(state, blankState());
  supabaseServerImpl = null;
});

describe("GET /api/admin/waitlist/export", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await GET(req());
    expect(r.status).toBe(403);
  });

  it("403s with mfa_required for an admin whose session is only AAL1 (guardrail)", async () => {
    asAdmin();
    state.aal = "aal1";
    const r = await GET(req());
    expect(r.status).toBe(403);
    const j = await r.json();
    expect(j.error.code).toBe("mfa_required");
  });

  it("200s for an admin with a CSV attachment", async () => {
    useRows([
      { id: "1", email: "a@example.com", source: "marketing", created_at: "2026-09-01T10:00:00Z" },
    ]);
    const r = await GET(req());
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(r.headers.get("content-disposition")).toContain("attachment");
    expect(r.headers.get("content-disposition")).toContain(".csv");
    const body = await r.text();
    expect(body.startsWith("email,source,joined_at")).toBe(true);
  });

  it("covers rows beyond page 1 — a 1500-row waitlist exports all 1500", async () => {
    // The shared fake's `.range()` is a NO-OP, so it cannot tell a correct
    // paging loop from a broken one. Swap in a client that honours the window,
    // and seed more rows than one batch holds — otherwise this test is green
    // whether or not the export actually pages.
    useRows(
      Array.from({ length: 1500 }, (_, i) => ({
        id: `id${i}`,
        email: `person${i}@example.com`,
        source: "marketing",
        created_at: "2026-09-01T00:00:00Z",
      })),
    );

    // Deliberately asks for the LAST page's window; the export must ignore it.
    const r = await GET(req("?offset=1499&limit=1"));
    const body = await r.text();
    const lines = body.trim().split(/\r\n/);

    expect(lines).toHaveLength(1501); // header + 1500 rows
    expect(body).toContain("person0@example.com");
    expect(body).toContain("person1200@example.com"); // only reachable past batch 1
    expect(body).toContain("person1499@example.com");
  });

  it("reads the waitlist table and nothing else (no join against member data)", async () => {
    asAdmin();
    state.tables.waitlist = { select: { rows: [] } };
    await GET(req());

    expect([...new Set(state.calls.from)].sort()).toEqual(["app_user", "waitlist"]);
  });

  it("escapes a comma/quote in an email and neutralises a formula-like source", async () => {
    useRows([
      { id: "1", email: 'a,"b"@example.com', source: "=cmd", created_at: "2026-09-01T10:00:00Z" },
    ]);
    const r = await GET(req());
    const body = await r.text();
    expect(body).toContain('"a,""b""@example.com"');
    expect(body).toContain("'=cmd");
  });
});
