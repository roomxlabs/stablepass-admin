import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

// Swappable so the `view=list` tests can substitute a client whose `.range()`
// actually slices — the shared fake's is a no-op, which cannot terminate
// `fetchAllSubscribers`'s paging loop (see app/(dash)/subscribers/data.test.ts
// for the same reasoning). The existing aggregate-mode tests below never touch
// this and keep using the plain `state`-driven fake.
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
 * Installs a Supabase stand-in that ACTUALLY honours `.range(from,to)`, as an
 * authenticated AAL2 admin, for the `view=list` tests. Mirrors the equivalent
 * helper in app/api/admin/waitlist/export/route.test.ts.
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

  describe("?view=list", () => {
    it("returns subscriber rows and a total/matching meta", async () => {
      useSubscriptionRows([
        subRow({ id: "1", user: { name: "Ann", email: "ann@example.com", is_admin: false } }),
        subRow({ id: "2", status: "trial", user: { name: "Bob", email: "bob@example.com", is_admin: false } }),
      ]);
      const r = await GET(req("?view=list"));
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j.data).toHaveLength(2);
      expect(j.data[0]).toMatchObject({ name: "Ann", email: "ann@example.com", status: "active" });
      expect(typeof j.data[0].tenureMonths).toBe("number");
      expect(j.meta).toMatchObject({ total: 2, matching: 2, offset: 0, limit: 25 });
    });

    it("excludes a staff (is_admin) row (guardrail)", async () => {
      useSubscriptionRows([
        subRow({ id: "1", user: { name: "Ann", email: "ann@example.com", is_admin: false } }),
        subRow({ id: "2", user: { name: "Ops", email: "ops@example.com", is_admin: true } }),
      ]);
      const r = await GET(req("?view=list"));
      const j = await r.json();
      expect(j.data.map((row: { email: string }) => row.email)).toEqual(["ann@example.com"]);
      expect(j.meta.total).toBe(1);
    });

    it("?status=canceled returns only canceled rows, each with a non-null canceledAt", async () => {
      useSubscriptionRows([
        subRow({ id: "1", status: "active" }),
        subRow({ id: "2", status: "canceled", updated_at: "2026-06-01T00:00:00Z" }),
      ]);
      const r = await GET(req("?view=list&status=canceled"));
      const j = await r.json();
      expect(j.data).toHaveLength(1);
      expect(j.data[0].status).toBe("canceled");
      expect(j.data[0].canceledAt).toBe("2026-06-01T00:00:00Z");
    });

    it("?minMonths=6 returns only the long-tenure cohort", async () => {
      useSubscriptionRows([
        subRow({ id: "1", created_at: "2020-01-01T00:00:00Z", user: { name: "Old", email: "old@example.com" } }),
        subRow({ id: "2", created_at: new Date().toISOString(), user: { name: "New", email: "new@example.com" } }),
      ]);
      const r = await GET(req("?view=list&minMonths=6"));
      const j = await r.json();
      expect(j.data.map((row: { email: string }) => row.email)).toEqual(["old@example.com"]);
    });

    it("403s for a non-admin", async () => {
      asNonAdmin();
      const r = await GET(req("?view=list"));
      expect(r.status).toBe(403);
    });

    it("403s with mfa_required for an admin whose session is only AAL1 (guardrail)", async () => {
      useSubscriptionRows([subRow()], "aal1");
      const r = await GET(req("?view=list"));
      expect(r.status).toBe(403);
      const j = await r.json();
      expect(j.error.code).toBe("mfa_required");
    });
  });
});
