import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  tenureMonths,
  fetchAllSubscribers,
  applyFilters,
  listSubscribers,
  toCsv,
  SUBSCRIBERS_PAGE_SIZE,
  type SubscriberRow,
} from "./data";

// Fixed clock so every test in this file is not clock-dependent.
const NOW = new Date("2026-09-05T00:00:00Z");

describe("tenureMonths", () => {
  it("counts a whole completed month when the day-of-month has been reached", () => {
    // Same day-of-month, one month earlier: a full month has elapsed.
    expect(tenureMonths("2026-08-05T00:00:00Z", NOW)).toBe(1);
  });

  it("does not count a month that is one day short of completing", () => {
    expect(tenureMonths("2026-08-06T00:00:00Z", NOW)).toBe(0);
  });

  it("returns 0 for null", () => {
    expect(tenureMonths(null, NOW)).toBe(0);
  });

  it("returns 0 for an unparseable date", () => {
    expect(tenureMonths("not-a-date", NOW)).toBe(0);
  });

  it("returns 0 for a future date", () => {
    expect(tenureMonths("2026-10-05T00:00:00Z", NOW)).toBe(0);
  });

  it("counts several full years correctly", () => {
    expect(tenureMonths("2024-09-05T00:00:00Z", NOW)).toBe(24);
  });

  // MONTH-END CLAMP. A short month can never reach day 29/30/31, so the
  // anniversary is treated as landing on that month's last day. Without the
  // clamp each of these reads one month LOW, which at a band edge files the
  // subscriber into the wrong cohort — the one thing this screen must get right.
  it("treats the last day of a short month as the anniversary of a 31st", () => {
    // 31 Jan -> 28 Feb is a completed month, not zero.
    expect(tenureMonths("2026-01-31T00:00:00Z", new Date("2026-02-28T00:00:00Z"))).toBe(1);
  });

  it("clamps at a band edge (31 Mar -> 30 Jun is 3 months, not 2)", () => {
    expect(tenureMonths("2026-03-31T00:00:00Z", new Date("2026-06-30T00:00:00Z"))).toBe(3);
  });

  it("clamps at the 6-month band edge (31 Aug -> 28 Feb is 6 months)", () => {
    expect(tenureMonths("2025-08-31T00:00:00Z", new Date("2026-02-28T00:00:00Z"))).toBe(6);
  });

  it("gives a leap-day subscriber a full year on 28 Feb (12+, not 11)", () => {
    // The case that would drop a full-year subscriber into "6-11 months".
    expect(tenureMonths("2024-02-29T00:00:00Z", new Date("2025-02-28T00:00:00Z"))).toBe(12);
  });

  it("still does not over-count mid-month after the clamp", () => {
    // 30 Sep has 30 days, so day 5 is nowhere near the clamp: a 31 Aug start
    // must still read 0 completed months on 5 Sep.
    expect(tenureMonths("2026-08-31T00:00:00Z", NOW)).toBe(0);
    // And a plain one-day-short case in a LONG month is unaffected.
    expect(tenureMonths("2026-07-06T00:00:00Z", new Date("2026-08-05T00:00:00Z"))).toBe(0);
  });
});

// A Supabase stand-in that ACTUALLY HONOURS `.range(from,to)`. The shared
// fake's `.range()` is a no-op, which makes it structurally unable to test a
// paging loop: every batch returns the same rows, so a loop that pages
// correctly and one that does not look identical. Mirrors the equivalent
// helper in app/(dash)/waitlist/data.test.ts.
type SubscriptionDbLike = {
  id: string;
  status: string;
  created_at: string;
  updated_at: string | null;
  current_period_end: string | null;
  user: { name?: string | null; email?: string | null; is_admin?: boolean | null } | { name?: string | null; email?: string | null; is_admin?: boolean | null }[] | null;
};

function makeRangeClient(all: SubscriptionDbLike[], opts: { serverCap?: number } = {}) {
  const cap = opts.serverCap ?? 1000;
  const calls: { from: number; to: number }[] = [];
  const client = {
    from: () => {
      const b = {
        select: () => b,
        order: () => b,
        range: async (from: number, to: number) => {
          calls.push({ from, to });
          const want = to - from + 1;
          return { data: all.slice(from, from + Math.min(want, cap)), error: null, count: all.length };
        },
      };
      return b;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

function row(overrides: Partial<SubscriptionDbLike> = {}): SubscriptionDbLike {
  return {
    id: "sub1",
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    current_period_end: "2026-10-01T00:00:00Z",
    user: { name: "Ann", email: "ann@example.com", is_admin: false },
    ...overrides,
  };
}

function manyRows(n: number): SubscriptionDbLike[] {
  return Array.from({ length: n }, (_, i) =>
    row({
      id: `id${i}`,
      user: { name: `Person ${i}`, email: `person${i}@example.com`, is_admin: false },
    }),
  );
}

describe("fetchAllSubscribers", () => {
  it("excludes a staff (is_admin) row", async () => {
    const { client } = makeRangeClient([
      row({ id: "1", user: { name: "Ann", email: "ann@example.com", is_admin: false } }),
      row({ id: "2", user: { name: "Ops", email: "ops@example.com", is_admin: true } }),
    ]);
    const rows = await fetchAllSubscribers(client, NOW);
    expect(rows.map((r) => r.id)).toEqual(["1"]);
  });

  it("excludes a row with no usable email", async () => {
    const { client } = makeRangeClient([
      row({ id: "1", user: { name: "Ann", email: "ann@example.com", is_admin: false } }),
      row({ id: "2", user: { name: "Bad", email: "", is_admin: false } }),
      row({ id: "3", user: null }),
    ]);
    const rows = await fetchAllSubscribers(client, NOW);
    expect(rows.map((r) => r.id)).toEqual(["1"]);
  });

  it("derives canceledAt from updated_at only when status is canceled", async () => {
    const { client } = makeRangeClient([
      row({ id: "1", status: "canceled", updated_at: "2026-08-01T00:00:00Z" }),
      row({ id: "2", status: "active", updated_at: "2026-08-15T00:00:00Z" }),
    ]);
    const rows = await fetchAllSubscribers(client, NOW);
    const canceled = rows.find((r) => r.id === "1")!;
    const active = rows.find((r) => r.id === "2")!;
    expect(canceled.canceledAt).toBe("2026-08-01T00:00:00Z");
    // Even though the active row also has an updated_at, it must not be read
    // as a cancellation date.
    expect(active.canceledAt).toBeNull();
  });

  it("handles the user embed arriving as a 1-element array (PostgREST to-one quirk)", async () => {
    const { client } = makeRangeClient([
      row({ id: "1", user: [{ name: "Ann", email: "ann@example.com", is_admin: false }] }),
    ]);
    const rows = await fetchAllSubscribers(client, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("ann@example.com");
    expect(rows[0].name).toBe("Ann");
  });

  it("excludes a staff row even when the embed arrives as a 1-element array", async () => {
    const { client } = makeRangeClient([
      row({ id: "1", user: [{ name: "Ops", email: "ops@example.com", is_admin: true }] }),
    ]);
    const rows = await fetchAllSubscribers(client, NOW);
    expect(rows).toHaveLength(0);
  });

  it("pages past the first batch — 2500 subscribers fetches all 2500", async () => {
    const { client, calls } = makeRangeClient(manyRows(2500));
    const rows = await fetchAllSubscribers(client, NOW);

    expect(rows).toHaveLength(2500);
    expect(rows.map((r) => r.email)).toContain("person1500@example.com");
    expect(rows.map((r) => r.email)).toContain("person2499@example.com");
    expect(calls[0].from).toBe(0);
    expect(calls[1].from).toBe(1000);
    expect(calls[2].from).toBe(2000);
  });

  it("does NOT stop at a short batch caused by a server row cap", async () => {
    const { client } = makeRangeClient(manyRows(1200), { serverCap: 500 });
    const rows = await fetchAllSubscribers(client, NOW);
    expect(rows).toHaveLength(1200);
  });

  it("throws rather than returning a truncated list when batches never empty", async () => {
    const endless = {
      from: () => {
        const b = {
          select: () => b,
          order: () => b,
          range: async () => ({ data: manyRows(1000), error: null, count: null }),
        };
        return b;
      },
    } as unknown as SupabaseClient;

    await expect(fetchAllSubscribers(endless, NOW)).rejects.toThrow(
      /refusing to return a possibly-truncated list/,
    );
  });
});

const ROWS: SubscriberRow[] = [
  {
    id: "1",
    name: "Ann",
    email: "ann@example.com",
    status: "active",
    startedAt: "2026-01-05T00:00:00Z",
    currentPeriodEnd: "2026-10-05T00:00:00Z",
    canceledAt: null,
    tenureMonths: 8,
  },
  {
    id: "2",
    name: "Bob",
    email: "bob@example.com",
    status: "trial",
    startedAt: "2026-09-01T00:00:00Z",
    currentPeriodEnd: null,
    canceledAt: null,
    tenureMonths: 0,
  },
  {
    id: "3",
    name: "Cara",
    email: "cara@example.com",
    status: "canceled",
    startedAt: "2024-01-01T00:00:00Z",
    currentPeriodEnd: null,
    canceledAt: "2026-06-01T00:00:00Z",
    tenureMonths: 32,
  },
];

describe("applyFilters", () => {
  it("filters by exact status", () => {
    expect(applyFilters(ROWS, { status: "trial" }).map((r) => r.id)).toEqual(["2"]);
  });

  it("does not narrow when status is undefined or 'all'", () => {
    expect(applyFilters(ROWS, {}).map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(applyFilters(ROWS, { status: "all" }).map((r) => r.id)).toEqual(["1", "2", "3"]);
  });

  it("applies an inclusive tenure band", () => {
    expect(applyFilters(ROWS, { minMonths: 8, maxMonths: 8 }).map((r) => r.id)).toEqual(["1"]);
    expect(applyFilters(ROWS, { minMonths: 8 }).map((r) => r.id)).toEqual(["1", "3"]);
    expect(applyFilters(ROWS, { maxMonths: 0 }).map((r) => r.id)).toEqual(["2"]);
  });

  it("ignores an undefined/NaN tenure bound", () => {
    expect(applyFilters(ROWS, { minMonths: NaN }).map((r) => r.id)).toEqual(["1", "2", "3"]);
  });

  it("matches q case-insensitively over name and email", () => {
    expect(applyFilters(ROWS, { q: "BOB" }).map((r) => r.id)).toEqual(["2"]);
    expect(applyFilters(ROWS, { q: "cara@example" }).map((r) => r.id)).toEqual(["3"]);
  });

  it("combines filters", () => {
    expect(applyFilters(ROWS, { status: "active", q: "ann" }).map((r) => r.id)).toEqual(["1"]);
  });
});

describe("listSubscribers", () => {
  it("reports total ignoring filters while matching reflects them", async () => {
    const { client } = makeRangeClient(
      ROWS.map((r) =>
        row({
          id: r.id,
          status: r.status,
          created_at: r.startedAt!,
          updated_at: r.canceledAt ?? r.startedAt!,
          current_period_end: r.currentPeriodEnd,
          user: { name: r.name, email: r.email, is_admin: false },
        }),
      ),
    );
    const result = await listSubscribers(client, { status: "trial" }, NOW);
    expect(result.total).toBe(3);
    expect(result.matching).toBe(1);
  });

  it("respects offset/limit as a window over the filtered rows", async () => {
    const { client } = makeRangeClient(manyRows(10));
    const result = await listSubscribers(client, { offset: 2, limit: 3 }, NOW);
    expect(result.rows).toHaveLength(3);
    expect(result.rows.map((r) => r.id)).toEqual(["id2", "id3", "id4"]);
    expect(result.offset).toBe(2);
    expect(result.limit).toBe(3);
  });

  it("defaults offset to 0 and limit to SUBSCRIBERS_PAGE_SIZE", async () => {
    const { client } = makeRangeClient(manyRows(3));
    const result = await listSubscribers(client, {}, NOW);
    expect(result.offset).toBe(0);
    expect(result.limit).toBe(SUBSCRIBERS_PAGE_SIZE);
  });
});

describe("toCsv", () => {
  it("writes the exact header row", () => {
    const csv = toCsv([]);
    expect(csv.split("\r\n")[0]).toBe(
      "name,email,status,started_at,tenure_months,current_period_end,canceled_at",
    );
  });

  it("writes one CRLF-terminated line per row with a trailing newline", () => {
    const csv = toCsv([ROWS[0]]);
    expect(csv).toBe(
      "name,email,status,started_at,tenure_months,current_period_end,canceled_at\r\n" +
        "Ann,ann@example.com,active,2026-01-05T00:00:00Z,8,2026-10-05T00:00:00Z,\r\n",
    );
  });

  it("escapes a comma/quote in a name", () => {
    const csv = toCsv([{ ...ROWS[0], name: 'Ann,"Q"' }]);
    expect(csv).toContain('"Ann,""Q"""');
  });

  it("neutralises a leading = in a name (CSV injection)", () => {
    const csv = toCsv([{ ...ROWS[0], name: "=cmd|'/c calc'!A1" }]);
    expect(csv).toContain("'=cmd|'/c calc'!A1");
  });
});


// ---------------------------------------------------------------------------
// Query errors must be LOUD. supabase-js returns `{ data: null, error }` rather
// than throwing, so an unchecked error becomes an empty batch, which the paging
// loop would read as its normal "that was the last of them" signal. That turns
// a backend failure into a silently short list — a truncated CSV that looks
// complete, or a "No subscribers yet" empty state on a healthy database.
// ---------------------------------------------------------------------------

/** A client whose Nth `.range()` call (0-based) fails, and which pages otherwise. */
function makeFailingClient(all: SubscriptionDbLike[], failOnCall: number) {
  let call = 0;
  const client = {
    from: () => {
      const b = {
        select: () => b,
        order: () => b,
        range: async (from: number, to: number) => {
          const n = call++;
          if (n === failOnCall) {
            return { data: null, error: { message: "statement timeout", code: "57014" }, count: null };
          }
          const want = to - from + 1;
          return { data: all.slice(from, from + want), error: null, count: all.length };
        },
      };
      return b;
    },
  } as unknown as SupabaseClient;
  return client;
}

function dbRow(n: number, over: Partial<SubscriptionDbLike> = {}): SubscriptionDbLike {
  return {
    id: `s${n}`,
    status: "active",
    created_at: "2026-01-15T00:00:00Z",
    updated_at: "2026-01-15T00:00:00Z",
    current_period_end: "2026-10-01T00:00:00Z",
    user: { name: `Member ${n}`, email: `m${n}@example.com`, is_admin: false },
    ...over,
  };
}

describe("fetchAllSubscribers — query errors", () => {
  it("throws on a FIRST-batch error instead of reporting an empty subscriber base", async () => {
    const client = makeFailingClient([dbRow(1), dbRow(2)], 0);
    await expect(fetchAllSubscribers(client, NOW)).rejects.toThrow(/statement timeout/);
  });

  it("throws on a MID-LOOP error instead of returning a truncated list", async () => {
    // 1500 rows over a 1000-row batch size: batch 0 succeeds, batch 1 fails.
    // The old behaviour returned the first 1000 rows with no error at all.
    const rows = Array.from({ length: 1500 }, (_, i) => dbRow(i));
    const client = makeFailingClient(rows, 1);
    await expect(fetchAllSubscribers(client, NOW)).rejects.toThrow(/failed at offset 1000/);
  });

  it("names the offset it failed at, so a partial read is diagnosable", async () => {
    const client = makeFailingClient([dbRow(1)], 0);
    await expect(fetchAllSubscribers(client, NOW)).rejects.toThrow(/offset 0/);
  });

  it("propagates the error through listSubscribers rather than rendering an empty page", async () => {
    const client = makeFailingClient([dbRow(1)], 0);
    await expect(listSubscribers(client, {}, NOW)).rejects.toThrow(/statement timeout/);
  });
});

// The FORMULA_PREFIX regex covers four lead characters and several invisible
// prefixes. Testing only `=` would let a "simplification" of it to /^=/ pass
// green while re-opening formula execution for the other three.
describe("toCsv — formula injection, beyond the obvious `=`", () => {
  function row(name: string): SubscriberRow {
    return {
      id: "s1",
      name,
      email: "m@example.com",
      status: "active",
      startedAt: null,
      currentPeriodEnd: null,
      canceledAt: null,
      tenureMonths: 0,
    };
  }
  const dataLine = (name: string) => toCsv([row(name)]).split("\r\n")[1];

  it.each(["=1+1", "+1", "-1+2", "@SUM(A1)"])("neutralises a leading %s", (payload) => {
    expect(dataLine(payload).startsWith("'")).toBe(true);
  });

  it.each([
    ["tab", "\t=1+1"],
    ["space", " =1+1"],
    ["NBSP", "\u00A0=1+1"],
    ["BOM", "\uFEFF=1+1"],
  ])("neutralises a payload hidden behind a leading %s", (_label, payload) => {
    // Quoting may wrap it, so assert the prefix sits before the payload rather
    // than at index 0.
    expect(dataLine(payload)).toContain("'");
    expect(dataLine(payload).indexOf("'")).toBeLessThan(dataLine(payload).indexOf("="));
  });

  it("leaves an ordinary name untouched", () => {
    expect(dataLine("Harriet Vale")).toBe("Harriet Vale,m@example.com,active,,0,,");
  });

  it("still quotes AND prefixes a payload containing a comma", () => {
    expect(dataLine("=1+1,x")).toBe('"\'=1+1,x",m@example.com,active,,0,,');
  });
});
