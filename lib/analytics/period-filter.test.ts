import { describe, it, expect } from "vitest";
import { getOpens, getEngagement, getClicks } from "./queries";

// ENG-984 regression guard for the PERIOD BOUND.
//
// Before this ticket the period was provable from the RPC arguments: the route
// tests asserted `admin_opens_by_day` was called with `{ p_since: null }` for
// `period=all`. Moving the aggregation into TS removed that assertion's
// subject, and nothing replaced it — the shared supabase fake records `.eq()`
// / `.gte()` only for MUTATIONS (see `lib/testing/supabase-fake.ts`), so a read
// filter is invisible to it.
//
// That left a hole big enough to drive a bug through: if `getOpens` stopped
// applying `since`, `?period=7d` would silently return ALL-TIME numbers and
// every test in the repo would still pass. So this file uses its own tiny
// recording client — one that captures read filters — rather than the shared
// fake.

type Recorded = { table: string; gte: { column: string; value: string }[] };

function recordingClient(rowsByTable: Record<string, unknown[]> = {}) {
  const calls: Recorded[] = [];

  function builder(table: string) {
    const rec: Recorded = { table, gte: [] };
    calls.push(rec);
    const b: Record<string, unknown> = {};
    const self = () => b;
    b.select = self;
    b.eq = self;
    b.order = self;
    b.gte = (column: string, value: string) => {
      rec.gte.push({ column, value });
      return b;
    };
    // `fetchAllRows` ends every read with `.range(...)`; `getAdminUserIds`
    // awaits the builder directly. Support both.
    b.range = async () => ({ data: rowsByTable[table] ?? [], error: null, count: null });
    b.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: rowsByTable[table] ?? [], error: null, count: null }).then(resolve);
    return b;
  }

  return {
    calls,
    sb: {
      from: (table: string) => builder(table),
      rpc: async () => ({ data: [], error: null }),
    },
  };
}

const SINCE = "2026-08-01T00:00:00.000Z";

describe("analytics period bound is actually applied to the engagement reads", () => {
  it("getOpens filters impression on seen_at >= since", async () => {
    const { sb, calls } = recordingClient();
    await getOpens(sb as never, SINCE);

    const impression = calls.find((c) => c.table === "impression");
    expect(impression, "impression was never read").toBeDefined();
    expect(impression!.gte).toContainEqual({ column: "seen_at", value: SINCE });
  });

  it("getOpens applies NO period filter when since is null (period=all)", async () => {
    const { sb, calls } = recordingClient();
    await getOpens(sb as never, null);

    const impression = calls.find((c) => c.table === "impression");
    expect(impression!.gte).toEqual([]);
  });

  it("getEngagement bounds all four engagement tables on their own timestamp column", async () => {
    const { sb, calls } = recordingClient();
    await getEngagement(sb as never, SINCE);

    const expected: Record<string, string> = {
      impression: "seen_at",
      reaction: "created_at",
      bookmark: "created_at",
      trainer_website_click: "clicked_at",
    };
    for (const [table, column] of Object.entries(expected)) {
      const c = calls.find((x) => x.table === table);
      expect(c, `${table} was never read`).toBeDefined();
      expect(c!.gte, `${table} was not bounded by the period`).toContainEqual({
        column,
        value: SINCE,
      });
    }
  });

  it("getClicks bounds trainer_website_click on clicked_at", async () => {
    const { sb, calls } = recordingClient();
    await getClicks(sb as never, SINCE);

    const clicks = calls.find((c) => c.table === "trainer_website_click");
    expect(clicks, "trainer_website_click was never read").toBeDefined();
    expect(clicks!.gte).toContainEqual({ column: "clicked_at", value: SINCE });
  });
});
