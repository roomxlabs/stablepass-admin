import { describe, it, expect, beforeEach } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";
import { getAdminUserIds, excludeAdminRows, memberRows, pageOrderKey } from "./admin-exclusion";

const state: FakeState = blankState();

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("excludeAdminRows", () => {
  it("drops rows produced by an operator", () => {
    const adminIds = new Set(["admin-1"]);
    const rows = [{ user_id: "admin-1" }, { user_id: "member-1" }];
    expect(excludeAdminRows(rows, adminIds)).toEqual([{ user_id: "member-1" }]);
  });

  it("keeps rows with a null user_id (cannot be attributed to an admin)", () => {
    const adminIds = new Set(["admin-1"]);
    const rows = [{ user_id: null }, { user_id: "admin-1" }, { user_id: "member-1" }];
    expect(excludeAdminRows(rows, adminIds)).toEqual([{ user_id: null }, { user_id: "member-1" }]);
  });
});

describe("memberRows", () => {
  it("throws when columns omits user_id", async () => {
    const sb = makeFakeClient(state) as unknown as Parameters<typeof memberRows>[0];
    await expect(memberRows(sb, "impression", "seen_at")).rejects.toThrow(/user_id/);
  });

  it("excludes admin rows given an explicit adminIds set", async () => {
    state.tables.impression = {
      select: {
        rows: [
          { user_id: "admin-1", seen_at: "2026-07-01T00:00:00.000Z" },
          { user_id: "member-1", seen_at: "2026-07-02T00:00:00.000Z" },
        ],
      },
    };
    const sb = makeFakeClient(state) as unknown as Parameters<typeof memberRows>[0];
    const rows = await memberRows(sb, "impression", "user_id,seen_at", undefined, new Set(["admin-1"]));
    expect(rows).toEqual([{ user_id: "member-1", seen_at: "2026-07-02T00:00:00.000Z" }]);
  });
});

describe("getAdminUserIds", () => {
  it("throws on a query error", async () => {
    state.tables.app_user = { select: { error: { message: "connection reset" } } };
    const sb = makeFakeClient(state) as unknown as Parameters<typeof getAdminUserIds>[0];
    await expect(getAdminUserIds(sb)).rejects.toThrow(/admin exclusion/);
  });

  it("returns the set of admin app_user ids", async () => {
    state.tables.app_user = { select: { rows: [{ id: "admin-1" }, { id: "admin-2" }] } };
    const sb = makeFakeClient(state) as unknown as Parameters<typeof getAdminUserIds>[0];
    const ids = await getAdminUserIds(sb);
    expect(ids).toEqual(new Set(["admin-1", "admin-2"]));
  });
});

// ---------------------------------------------------------------------------
// PAGING (ENG-984 review, MUST-FIX 2 + 3)
//
// The shared `supabase-fake` records `.range()` but does not SLICE on it, and
// it returns no `count`, so every test above takes `fetchAllRows`'s
// `if (total == null) return all` early exit. The loop body's second and later
// iterations therefore never executed anywhere in the suite — which is both a
// coverage hole and the reason the missing ORDER BY was invisible.
//
// This fake is deliberately a paging simulator rather than a stub:
//   * it honours `.range(from, to)` by actually slicing,
//   * it returns the exact `count`, as PostgREST does for `count: "exact"`,
//   * and with NO `.order()` it serves each query from a DIFFERENT rotation of
//     the row set — which is exactly what an unordered Postgres scan is
//     permitted to do (`synchronize_seqscans` starts a later seq scan at a
//     different block; a concurrent insert/delete shifts rows under the
//     offset). It is not adversarial noise, it is the documented contract.
//
// So `fetchAllRows` paging without an ORDER BY returns the right NUMBER of
// rows built from the wrong ones — repeats and drops — and the identity
// assertions below go red.
// ---------------------------------------------------------------------------

type PageRow = { user_id: string | null; post_id: string };

function makePagingClient(table: string, rows: PageRow[]) {
  const queries: { order: string[]; from: number; to: number }[] = [];
  let scanNo = 0;

  const builder = () => {
    const orderCols: string[] = [];
    const chain = {
      order(column: string) {
        orderCols.push(column);
        return chain;
      },
      // Present so `shape` callbacks (period bounds, post id) still chain.
      gte() {
        return chain;
      },
      eq() {
        return chain;
      },
      then(resolve: (v: unknown) => unknown) {
        return Promise.resolve(undefined).then(resolve);
      },
      range(from: number, to: number) {
        queries.push({ order: [...orderCols], from, to });

        let scan: PageRow[];
        if (orderCols.length > 0) {
          // Deterministic: sort by the requested key, as Postgres would.
          scan = [...rows].sort((a, b) => {
            for (const c of orderCols) {
              const av = String((a as Record<string, unknown>)[c] ?? "");
              const bv = String((b as Record<string, unknown>)[c] ?? "");
              if (av !== bv) return av < bv ? -1 : 1;
            }
            return 0;
          });
        } else {
          // Unordered: each scan is free to start somewhere else.
          const shift = (++scanNo * 37) % Math.max(rows.length, 1);
          scan = [...rows.slice(shift), ...rows.slice(0, shift)];
        }

        return Promise.resolve({
          data: scan.slice(from, to + 1),
          error: null,
          count: rows.length,
        });
      },
    };
    return chain;
  };

  const sb = {
    from(t: string) {
      if (t !== table) throw new Error(`paging fake only models "${table}", got "${t}"`);
      return { select: () => builder() };
    },
  };
  return { sb, queries };
}

// 2,500 rows = three batches at PAGE_SIZE 1000, so batches 2 and 3 must run.
function seedRows(n: number): PageRow[] {
  return Array.from({ length: n }, (_, i) => ({
    user_id: `member-${String(i).padStart(5, "0")}`,
    post_id: `post-${String(i).padStart(5, "0")}`,
  }));
}

describe("fetchAllRows paging (via memberRows)", () => {
  it("pages past the first batch and returns EVERY row exactly once", async () => {
    const rows = seedRows(2500);
    const { sb, queries } = makePagingClient("impression", rows);

    const got = await memberRows<PageRow>(
      sb as unknown as Parameters<typeof memberRows>[0],
      "impression",
      "user_id,post_id",
      undefined,
      new Set<string>(),
    );

    // Count is not enough — a torn page returns 2500 rows too. Assert IDENTITY.
    expect(got).toHaveLength(2500);
    const ids = got.map((r) => r.post_id);
    expect(new Set(ids).size, "duplicate rows returned — pages overlapped").toBe(2500);
    expect([...ids].sort()).toEqual(rows.map((r) => r.post_id).sort());

    // Three batches, each advancing by rows RECEIVED, not re-fetching page 0.
    expect(queries.map((q) => [q.from, q.to])).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("orders every page on the table's unique key before ranging", async () => {
    const { sb, queries } = makePagingClient("impression", seedRows(2500));
    await memberRows<PageRow>(
      sb as unknown as Parameters<typeof memberRows>[0],
      "impression",
      "user_id,post_id",
      undefined,
      new Set<string>(),
    );

    expect(queries).not.toHaveLength(0);
    for (const q of queries) {
      expect(q.order, "a .range() was issued with no ORDER BY — pages can tear").toEqual([
        "user_id",
        "post_id",
      ]);
    }
  });

  it("still excludes admin rows that fall in a LATER page", async () => {
    // The admin sorts last on the unique key, so it is only ever seen on the
    // final batch. A single-batch read would never exercise this.
    const rows = [...seedRows(2400), { user_id: "zz-admin-1", post_id: "post-zzzzz" }];
    const { sb } = makePagingClient("impression", rows);

    const got = await memberRows<PageRow>(
      sb as unknown as Parameters<typeof memberRows>[0],
      "impression",
      "user_id,post_id",
      undefined,
      new Set(["zz-admin-1"]),
    );

    expect(got).toHaveLength(2400);
    expect(got.some((r) => r.user_id === "zz-admin-1")).toBe(false);
  });

  it("refuses to page a table with no registered unique sort key", async () => {
    const { sb } = makePagingClient("mystery_table", seedRows(3));
    await expect(
      memberRows(
        sb as unknown as Parameters<typeof memberRows>[0],
        "mystery_table",
        "user_id",
        undefined,
        new Set<string>(),
      ),
    ).rejects.toThrow(/no paging sort key registered/);
  });
});

describe("pageOrderKey", () => {
  it("registers a UNIQUE key for every engagement table analytics reads", () => {
    // These are the five tables `lib/analytics/queries.ts` and
    // `lib/dashboard/queries.ts` page through. A non-unique key would let ties
    // reorder between queries and reintroduce the tearing on a smaller scale.
    expect(pageOrderKey("impression")).toEqual(["user_id", "post_id"]);
    expect(pageOrderKey("reaction")).toEqual(["user_id", "post_id"]);
    expect(pageOrderKey("bookmark")).toEqual(["user_id", "post_id"]);
    expect(pageOrderKey("follow")).toEqual(["id"]);
    expect(pageOrderKey("trainer_website_click")).toEqual(["id"]);
  });

  it("throws for an unregistered table rather than reading it unordered", () => {
    expect(() => pageOrderKey("post")).toThrow(/no paging sort key registered/);
  });
});
