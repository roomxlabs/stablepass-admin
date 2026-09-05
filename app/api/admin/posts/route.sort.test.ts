import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

// ENG-963 — the key test: `?sort=`/`?dir=` produce the right `.order()` calls
// on the `post` table, in the right order, ahead of the created_at tiebreaker.
// The shared fake's `.order()`/`.eq()` are no-ops that record nothing, and it
// is owned by another PR, so this file wraps the builder locally rather than
// editing it.

const state: FakeState = blankState();
const orders: { table: string; args: unknown[] }[] = [];
const eqs: { table: string; column: unknown; value: unknown }[] = [];

function wrapClient(client: ReturnType<typeof makeFakeClient>) {
  return {
    ...client,
    from: (t: string) => {
      const b = client.from(t);
      const origOrder = b.order;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (b as any).order = (...a: unknown[]) => {
        orders.push({ table: t, args: a });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (origOrder as any)(...a);
      };
      const origEq = b.eq;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (b as any).eq = (...a: unknown[]) => {
        eqs.push({ table: t, column: a[0], value: a[1] });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (origEq as any)(...a);
      };
      return b;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => wrapClient(makeFakeClient(state)),
}));

import { GET } from "./route";

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}

function postOrders() {
  return orders.filter((o) => o.table === "post");
}
function postEqs() {
  return eqs.filter((e) => e.table === "post");
}

beforeEach(() => {
  Object.assign(state, blankState());
  orders.length = 0;
  eqs.length = 0;
});

describe("GET /api/admin/posts — sort", () => {
  it("?sort=published&dir=asc orders published_at asc (nulls last), then created_at desc", async () => {
    asAdmin();
    state.tables.post = { select: { rows: [], count: 0 } };
    const r = await GET(new Request("http://t/api/admin/posts?sort=published&dir=asc"));
    expect(r.status).toBe(200);
    expect(postOrders()).toEqual([
      { table: "post", args: ["published_at", { ascending: true, nullsFirst: false }] },
      { table: "post", args: ["created_at", { ascending: false }] },
    ]);
  });

  it("?sort=horse uses the column's default dir (asc) and still tiebreaks on created_at desc", async () => {
    asAdmin();
    state.tables.post = { select: { rows: [], count: 0 } };
    const r = await GET(new Request("http://t/api/admin/posts?sort=horse"));
    expect(r.status).toBe(200);
    expect(postOrders()).toEqual([
      { table: "post", args: ["horse(display_name)", { ascending: true }] },
      { table: "post", args: ["created_at", { ascending: false }] },
    ]);
  });

  it("no ?sort= at all -> exactly one order call: created_at desc", async () => {
    asAdmin();
    state.tables.post = { select: { rows: [], count: 0 } };
    const r = await GET(new Request("http://t/api/admin/posts"));
    expect(r.status).toBe(200);
    expect(postOrders()).toEqual([{ table: "post", args: ["created_at", { ascending: false }] }]);
  });

  it("an unknown ?sort=bogus falls back to created_at desc and still 200s (not a 400)", async () => {
    asAdmin();
    state.tables.post = { select: { rows: [], count: 0 } };
    const r = await GET(new Request("http://t/api/admin/posts?sort=bogus"));
    expect(r.status).toBe(200);
    expect(postOrders()).toEqual([{ table: "post", args: ["created_at", { ascending: false }] }]);
  });

  it("?trainerId= filters source_trainer_id, not horse_id", async () => {
    asAdmin();
    state.tables.post = { select: { rows: [], count: 0 } };
    const trainerId = "11111111-1111-1111-1111-111111111111";
    const r = await GET(new Request(`http://t/api/admin/posts?trainerId=${trainerId}`));
    expect(r.status).toBe(200);
    expect(postEqs()).toContainEqual({ table: "post", column: "source_trainer_id", value: trainerId });
    expect(postEqs().some((e) => e.column === "horse_id")).toBe(false);
  });

  it("the {count:'exact'} envelope (count/hasMore) is unaffected by a sort", async () => {
    asAdmin();
    state.tables.post = {
      select: { rows: [{ id: "p1" }, { id: "p2" }], count: 5 },
    };
    const r = await GET(new Request("http://t/api/admin/posts?sort=status&dir=desc&limit=2"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.meta.count).toBe(5);
    expect(j.meta.hasMore).toBe(true);
  });
});
