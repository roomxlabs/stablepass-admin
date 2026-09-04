import { describe, it, expect, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";
import {
  listWaitlist,
  sanitize,
  emailsFor,
  toCsv,
  fetchAllWaitlist,
  WAITLIST_PAGE_SIZE,
} from "./data";

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

  it("returns matching/offset/limit alongside the unfiltered total", async () => {
    state.tables.waitlist = { select: { rows: ROWS, count: 2 } };
    const { total, matching, offset, limit } = await listWaitlist(sb(), { offset: 5, limit: 10 });

    expect(total).toBe(2);
    expect(matching).toBe(2);
    expect(offset).toBe(5);
    expect(limit).toBe(10);
  });

  it("takes the headline total from an exact server COUNT, not the rows fetched", async () => {
    // The page fetches 25 rows but the waitlist has 4000. Deriving the headline
    // from the returned rows (or from an uncapped select("id").length, which
    // PostgREST clips at db-max-rows) would freeze the number Mel is watching.
    state.tables.waitlist = { select: { rows: ROWS, count: 4000 } };
    const { total, rows } = await listWaitlist(sb(), { limit: 25 });

    expect(rows).toHaveLength(2);
    expect(total).toBe(4000);
  });

  it("defaults offset to 0 and limit to WAITLIST_PAGE_SIZE", async () => {
    state.tables.waitlist = { select: { rows: ROWS } };
    const { offset, limit } = await listWaitlist(sb());

    expect(offset).toBe(0);
    expect(limit).toBe(WAITLIST_PAGE_SIZE);
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
    await expect(listWaitlist(sb())).resolves.toEqual({
      rows: [],
      total: 0,
      matching: 0,
      offset: 0,
      limit: WAITLIST_PAGE_SIZE,
    });

    Object.assign(state, blankState());
    state.tables.waitlist = { select: { rows: undefined } };
    await expect(listWaitlist(sb())).resolves.toEqual({
      rows: [],
      total: 0,
      matching: 0,
      offset: 0,
      limit: WAITLIST_PAGE_SIZE,
    });
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

describe("toCsv", () => {
  it("writes the header and one CRLF-terminated line per row", () => {
    const csv = toCsv([
      { id: "1", email: "a@example.com", source: "marketing", joinedAt: "2026-09-01T10:00:00Z" },
    ]);
    expect(csv).toBe(
      "email,source,joined_at\r\na@example.com,marketing,2026-09-01T10:00:00Z\r\n",
    );
  });

  it("renders a null source/joinedAt as an empty field", () => {
    const csv = toCsv([{ id: "1", email: "a@example.com", source: null, joinedAt: null }]);
    expect(csv).toBe("email,source,joined_at\r\na@example.com,,\r\n");
  });

  it("quotes and doubles inner quotes for fields with a comma or a quote", () => {
    const csv = toCsv([
      { id: "1", email: 'a,"b"@example.com', source: "ok", joinedAt: null },
    ]);
    expect(csv).toContain('"a,""b""@example.com",ok,');
  });

  it("neutralises a formula hidden behind leading whitespace (tab/NBSP/BOM)", () => {
    // A spreadsheet still evaluates "\t=1+1". These payloads defeat a bare
    // /^[=+\-@]/ and, before this was fixed, were only defused as a side effect
    // of mapRows' cosmetic .trim() — so toCsv is tested DIRECTLY here, with no
    // trim in the way, to pin the defence where it is actually stated.
    for (const lead of ["\t", "\v", "\f", "\u00A0", "\uFEFF", " "]) {
      const csv = toCsv([
        { id: "1", email: "a@example.com", source: `${lead}=cmd|'/c calc'!A0`, joinedAt: null },
      ]);
      const field = csv.split("\r\n")[1].split(",")[1];
      // Quoted (it contains a comma) but, crucially, prefixed with ' inside.
      expect(field.replace(/^"/, "").startsWith("'")).toBe(true);
    }
  });

  it("prefixes a leading =, +, - or @ to neutralise a CSV/formula injection", () => {
    const csv = toCsv([
      { id: "1", email: "a@example.com", source: "=cmd|'/c calc'!A1", joinedAt: null },
    ]);
    expect(csv).toContain("'=cmd|'/c calc'!A1");
  });
});

// A Supabase stand-in that ACTUALLY HONOURS `.range(from,to)` and an optional
// server-side row cap. The shared fake's `.range()` is a no-op, which makes it
// structurally unable to test a paging loop: every batch returns the same rows,
// so a loop that pages correctly and one that does not look identical. This is
// deliberately local to the export tests rather than a change to the shared
// fake, whose no-op range the rest of the suite is written against.
function makeRangeClient(all: WaitlistDbLike[], opts: { serverCap?: number } = {}) {
  const cap = opts.serverCap ?? 1000;
  const calls: { from: number; to: number }[] = [];
  const client = {
    from: () => {
      const b = {
        select: () => b,
        order: () => b,
        ilike: () => b,
        range: async (from: number, to: number) => {
          calls.push({ from, to });
          const want = to - from + 1;
          // A real PostgREST clips the response at db-max-rows; the caller is
          // NOT told that it was clipped.
          return { data: all.slice(from, from + Math.min(want, cap)), error: null, count: all.length };
        },
      };
      return b;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

type WaitlistDbLike = { id: string; email: string; source: string | null; created_at: string };

function manyRows(n: number): WaitlistDbLike[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `id${i}`,
    email: `person${i}@example.com`,
    source: "marketing",
    created_at: `2026-09-01T00:00:00Z`,
  }));
}

describe("fetchAllWaitlist", () => {
  it("pages past the first batch — a 2500-row waitlist exports all 2500", async () => {
    const { client, calls } = makeRangeClient(manyRows(2500));
    const rows = await fetchAllWaitlist(client);

    expect(rows).toHaveLength(2500);
    // Rows that exist ONLY beyond batch 1 must be present.
    expect(rows.map((r) => r.email)).toContain("person1500@example.com");
    expect(rows.map((r) => r.email)).toContain("person2499@example.com");
    // It advanced the window rather than re-reading batch 1.
    expect(calls[0].from).toBe(0);
    expect(calls[1].from).toBe(1000);
    expect(calls[2].from).toBe(2000);
  });

  it("does NOT stop at a short batch caused by a server row cap (silent truncation)", async () => {
    // The server clips every response to 500 even though 1000 was asked for.
    // A loop that treats "short batch" as "last batch" returns 500 of 1200 rows
    // with no error — the admin then seeds the newsletter from 40% of the list.
    const { client } = makeRangeClient(manyRows(1200), { serverCap: 500 });
    const rows = await fetchAllWaitlist(client);

    expect(rows).toHaveLength(1200);
  });

  it("terminates on an empty batch", async () => {
    const { client, calls } = makeRangeClient(manyRows(1000));
    const rows = await fetchAllWaitlist(client);

    expect(rows).toHaveLength(1000);
    // Exactly one extra probe past the end, which comes back empty and stops it.
    expect(calls).toHaveLength(2);
  });

  it("THROWS rather than returning a possibly-truncated CSV if it runs out of batches", async () => {
    // A backend that never runs out of rows. Refusing loudly is the point: a
    // short CSV is indistinguishable from a complete one once downloaded.
    const endless = {
      from: () => {
        const b = {
          select: () => b,
          order: () => b,
          ilike: () => b,
          range: async () => ({ data: manyRows(1000), error: null, count: null }),
        };
        return b;
      },
    } as unknown as SupabaseClient;

    await expect(fetchAllWaitlist(endless)).rejects.toThrow(/refusing to return a possibly-truncated CSV/);
  });

  it("maps rows the same way the list does, and applies the search filter", async () => {
    const { client } = makeRangeClient([
      { id: "1", email: " b@example.com ", source: " marketing ", created_at: "2026-09-02T10:00:00Z" },
      { id: "2", email: "", source: null, created_at: "2026-09-01T10:00:00Z" },
    ]);
    const rows = await fetchAllWaitlist(client, { q: "example" });

    // The blank-address row is dropped, exactly as in listWaitlist.
    expect(rows).toEqual([
      { id: "1", email: "b@example.com", source: "marketing", joinedAt: "2026-09-02T10:00:00Z" },
    ]);
  });
});
