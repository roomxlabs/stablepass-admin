import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

// Swappable so the AAL1 gate test can substitute a client that reports an
// `aal1` session — the shared `state`-driven fake is always AAL2. Every other
// test here uses the plain fake.
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
function req(qs = ""): Request {
  return new Request(`http://t/api/admin/subscribers${qs}`);
}

type SubRow = {
  id: string;
  status: string;
  created_at: string;
  updated_at: string | null;
  current_period_end: string | null;
  user: { name?: string | null; email?: string | null; is_admin?: boolean | null } | null;
};

/**
 * Installs a Supabase stand-in at a chosen assurance level, used by the AAL1
 * gate test. Mirrors the equivalent helper in
 * app/api/admin/waitlist/export/route.test.ts.
 */
function useSubscriptionRows(all: SubRow[], aal: "aal1" | "aal2" = "aal2") {
  supabaseServerImpl = async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: aal, nextLevel: "aal2", currentAuthenticationMethods: [] },
          error: null,
        }),
      },
    },
    from: (table: string) => {
      const b: Record<string, unknown> = {
        select: () => b,
        order: () => b,
        eq: () => b,
        single: async () => ({ data: { is_admin: true }, error: null }),
        range: async (from: number, to: number) => ({
          data: table === "subscription" ? all.slice(from, to + 1) : [],
          error: null,
          count: all.length,
        }),
      };
      return b;
    },
  });
}

function subRow(overrides: Partial<SubRow> = {}): SubRow {
  return {
    id: "1",
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    current_period_end: null,
    user: { name: "Ann", email: "ann@example.com", is_admin: false },
    ...overrides,
  };
}

beforeEach(() => {
  Object.assign(state, blankState());
  supabaseServerImpl = null;
});

describe("GET /api/admin/subscribers", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await GET(req());
    expect(r.status).toBe(403);
  });

  it("returns aggregate counts by status (no member PII)", async () => {
    asAdmin();
    state.tables.subscription = {
      select: {
        rows: [
          { status: "active" },
          { status: "active" },
          { status: "trial" },
          { status: "canceled" },
          // Operator's signup trial — excluded from every tally (ENG-315).
          { status: "trial", user: { is_admin: true } },
        ],
      },
    };
    const r = await GET(req());
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.total).toBe(4);
    expect(j.data.byStatus).toEqual({ active: 2, trial: 1, canceled: 1 });
    // Aggregate-only guardrail: never leak a user_id / member row.
    expect(JSON.stringify(j.data)).not.toContain("user_id");
  });

  it("returns an empty aggregate when there are no subscribers", async () => {
    asAdmin();
    const r = await GET(req("?status=active"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.total).toBe(0);
    expect(j.data.byStatus).toEqual({});
  });

  // ENG-982 review @3f9cf51 (should-fix 1): this route deliberately has NO
  // per-row `?view=list` mode. It shipped one with zero consumers — the page
  // renders server-side via `listSubscribers()` — which put member name +
  // email on the wire for nobody. Removed; these two guard the removal.
  it("?view=list is NOT a per-row mode — it falls through to the aggregate, leaking no member PII", async () => {
    asAdmin();
    state.tables.subscription = {
      select: {
        rows: [
          { status: "active", user: { name: "Ann", email: "ann@example.com" } },
          { status: "canceled", user: { name: "Bob", email: "bob@example.com" } },
        ],
      },
    };
    const r = await GET(req("?view=list"));
    expect(r.status).toBe(200);
    const j = await r.json();
    // Aggregate shape, identical to the no-param call.
    expect(j.data.byStatus).toEqual({ active: 1, canceled: 1 });
    // The point: no member row, no name, no email, no user_id.
    const body = JSON.stringify(j);
    for (const leak of ["ann@example.com", "bob@example.com", "Ann", "Bob", "user_id"]) {
      expect(body).not.toContain(leak);
    }
  });

  // The two gate tests below covered the removed list mode; retained and
  // retargeted at the surviving aggregate path so this route keeps both
  // halves of its authorization coverage (guardrail).
  it("403s with mfa_required for an admin whose session is only AAL1 (guardrail)", async () => {
    useSubscriptionRows([subRow()], "aal1");
    const r = await GET(req());
    expect(r.status).toBe(403);
    const j = await r.json();
    expect(j.error.code).toBe("mfa_required");
  });
});
