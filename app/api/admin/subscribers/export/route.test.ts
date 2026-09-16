import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

// Swappable so one test can substitute a client whose `.range()` actually
// slices — the shared fake's is a no-op, which cannot terminate
// `fetchAllSubscribers`'s paging loop. Mirrors
// app/api/admin/waitlist/export/route.test.ts.
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

type SubRow = {
  id: string;
  status: string;
  provider?: string | null;
  created_at: string;
  updated_at: string | null;
  current_period_end: string | null;
  user: { name?: string | null; email?: string | null; is_admin?: boolean | null } | null;
};

function useRows(all: SubRow[], aal: "aal1" | "aal2" = "aal2") {
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

function req(qs = ""): Request {
  return new Request(`http://t/api/admin/subscribers/export${qs}`);
}

beforeEach(() => {
  Object.assign(state, blankState());
  supabaseServerImpl = null;
});

describe("GET /api/admin/subscribers/export", () => {
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
    useRows([subRow()]);
    const r = await GET(req());
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(r.headers.get("content-disposition")).toContain("attachment; filename=\"subscribers-");
    const body = await r.text();
    expect(body.startsWith("name,email,status,provider,started_at,tenure_months,current_period_end,canceled_at")).toBe(true);
    expect(body).toContain("ann@example.com");
  });

  it("excludes a staff (is_admin) row from the CSV", async () => {
    useRows([
      subRow({ id: "1", user: { name: "Ann", email: "ann@example.com", is_admin: false } }),
      subRow({ id: "2", user: { name: "Ops", email: "ops@example.com", is_admin: true } }),
    ]);
    const r = await GET(req());
    const body = await r.text();
    expect(body).toContain("ann@example.com");
    expect(body).not.toContain("ops@example.com");
  });

  it("honours the status filter rather than dumping everything", async () => {
    useRows([
      subRow({ id: "1", status: "active", user: { name: "Ann", email: "ann@example.com" } }),
      subRow({ id: "2", status: "canceled", updated_at: "2026-06-01T00:00:00Z", user: { name: "Cara", email: "cara@example.com" } }),
    ]);
    const r = await GET(req("?status=canceled"));
    const body = await r.text();
    expect(body).toContain("cara@example.com");
    expect(body).not.toContain("ann@example.com");
  });

  it("passes ?provider= through, carrying the provider column (ENG-1193)", async () => {
    useRows([
      subRow({ id: "1", provider: "app_store", user: { name: "Ann", email: "ann@example.com" } }),
      subRow({ id: "2", provider: "stripe", user: { name: "Bob", email: "bob@example.com" } }),
      subRow({ id: "3", provider: null, user: { name: "Cara", email: "cara@example.com" } }),
    ]);
    const r = await GET(req("?provider=app_store"));
    expect(r.status).toBe(200);
    const lines = (await r.text()).trim().split("\r\n");
    expect(lines[0]).toBe("name,email,status,provider,started_at,tenure_months,current_period_end,canceled_at");
    expect(lines).toHaveLength(2);
    // Tenure is wall-clock relative here (the route takes no `now`), so match it loosely.
    expect(lines[1]).toMatch(/^Ann,ann@example\.com,active,app_store,2026-01-01T00:00:00Z,\d+,,$/);
  });

  it("maps a NULL provider to stripe, and ?provider=stripe includes it", async () => {
    useRows([
      subRow({ id: "1", provider: "app_store", user: { name: "Ann", email: "ann@example.com" } }),
      subRow({ id: "3", provider: null, user: { name: "Cara", email: "cara@example.com" } }),
    ]);
    const r = await GET(req("?provider=stripe"));
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain("Cara,cara@example.com,active,stripe,");
    expect(body).not.toContain("ann@example.com");
  });
});
