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
const selects: { table: string; select: unknown }[] = [];

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
      const origSelect = b.select;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (b as any).select = (...a: unknown[]) => {
        selects.push({ table: t, select: a[0] });
        // PostgREST semantics: `horse:horse_id!inner(...)` is an INNER JOIN, so
        // a post with no horse row (trainer / StablePass, since post.horse_id
        // became nullable) is dropped from the ROWS and from count:"exact".
        // The fake otherwise returns whatever is seeded regardless of the
        // select string, which is precisely why ENG-1291 shipped green.
        // It filters the seeded rows IN PLACE. `beforeEach` reseeds from
        // `blankState()`, so nothing leaks between tests — but a single test
        // issuing two GETs against one seed would see the second read the
        // already-filtered rows. Reseed per GET if you write one.
        if (t === "post" && typeof a[0] === "string" && a[0].includes("horse:horse_id!inner(")) {
          const tbl = state.tables.post;
          if (tbl?.select?.rows) {
            const kept = tbl.select.rows.filter(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (r: any) => r.horse_id != null,
            );
            tbl.select.rows = kept;
            if (typeof tbl.select.count === "number") tbl.select.count = kept.length;
          }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (origSelect as any)(...a);
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
function postSelects(): string[] {
  return selects.filter((s) => s.table === "post" && typeof s.select === "string").map((s) => s.select as string);
}

beforeEach(() => {
  Object.assign(state, blankState());
  orders.length = 0;
  eqs.length = 0;
  selects.length = 0;
});

describe("GET /api/admin/posts — sort", () => {
  it("?sort=published&dir=asc orders published_at asc (nulls last), then the tiebreakers", async () => {
    asAdmin();
    state.tables.post = { select: { rows: [], count: 0 } };
    const r = await GET(new Request("http://t/api/admin/posts?sort=published&dir=asc"));
    expect(r.status).toBe(200);
    expect(postOrders()).toEqual([
      { table: "post", args: ["published_at", { ascending: true, nullsFirst: false }] },
      { table: "post", args: ["created_at", { ascending: false }] },
      { table: "post", args: ["id", { ascending: false }] },
    ]);
  });

  it("?sort=subject uses the column's default dir (asc) and still tiebreaks", async () => {
    asAdmin();
    state.tables.post = { select: { rows: [], count: 0 } };
    const r = await GET(new Request("http://t/api/admin/posts?sort=subject"));
    expect(r.status).toBe(200);
    expect(postOrders()).toEqual([
      // nullsFirst:false because subject_name is null when the name cannot be
      // resolved.
      { table: "post", args: ["subject_name", { ascending: true, nullsFirst: false }] },
      { table: "post", args: ["created_at", { ascending: false }] },
      { table: "post", args: ["id", { ascending: false }] },
    ]);
  });

  it("the legacy ?sort=horse bookmark still means the Posted-as sort (mapped to subject), and does not 500", async () => {
    asAdmin();
    state.tables.post = { select: { rows: [], count: 0 } };
    const r = await GET(new Request("http://t/api/admin/posts?sort=horse"));
    expect(r.status).toBe(200);
    expect(postOrders()).toEqual([
      { table: "post", args: ["subject_name", { ascending: true, nullsFirst: false }] },
      { table: "post", args: ["created_at", { ascending: false }] },
      { table: "post", args: ["id", { ascending: false }] },
    ]);
  });

  it("no ?sort= at all -> exactly the default order: created_at desc, then id desc", async () => {
    asAdmin();
    state.tables.post = { select: { rows: [], count: 0 } };
    const r = await GET(new Request("http://t/api/admin/posts"));
    expect(r.status).toBe(200);
    expect(postOrders()).toEqual([
      { table: "post", args: ["created_at", { ascending: false }] },
      // `id` is the PK tiebreaker: created_at is stable but not unique, and
      // offset pagination needs a TOTAL order or a row can land on two pages.
      { table: "post", args: ["id", { ascending: false }] },
    ]);
  });

  it("an unknown ?sort=bogus falls back to created_at desc and still 200s (not a 400)", async () => {
    asAdmin();
    state.tables.post = { select: { rows: [], count: 0 } };
    const r = await GET(new Request("http://t/api/admin/posts?sort=bogus"));
    expect(r.status).toBe(200);
    expect(postOrders()).toEqual([
      { table: "post", args: ["created_at", { ascending: false }] },
      // `id` is the PK tiebreaker: created_at is stable but not unique, and
      // offset pagination needs a TOTAL order or a row can land on two pages.
      { table: "post", args: ["id", { ascending: false }] },
    ]);
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

describe("GET /api/admin/posts — the select string the sort actually sends", () => {
  it("no produced select contains `!inner`, for ANY sort key", async () => {
    // The assertion that would have caught ENG-1291.
    asAdmin();
    for (const sort of ["", "subject", "published", "engagement", "status", "horse", "bogus"]) {
      state.tables.post = { select: { rows: [], count: 0 } };
      selects.length = 0;
      const url = sort ? `http://t/api/admin/posts?sort=${sort}` : "http://t/api/admin/posts";
      await GET(new Request(url));
      expect(postSelects().some((s) => s.includes("!inner"))).toBe(false);
    }
  });

  it("every produced select carries subject_name — the column the sort orders by", async () => {
    asAdmin();
    state.tables.post = { select: { rows: [], count: 0 } };
    await GET(new Request("http://t/api/admin/posts?sort=subject"));
    expect(postSelects().some((s) => s.includes("subject_name"))).toBe(true);
  });

  it("the select is byte-identical for every sort", async () => {
    asAdmin();
    state.tables.post = { select: { rows: [], count: 0 } };
    selects.length = 0;
    await GET(new Request("http://t/api/admin/posts?sort=subject"));
    const subjectSelect = postSelects()[0];

    selects.length = 0;
    await GET(new Request("http://t/api/admin/posts"));
    const defaultSelect = postSelects()[0];

    expect(subjectSelect).toBe(defaultSelect);
  });
});

// ENG-1291 regression: sorting by "Posted as" used to inner-join the horse
// embed, which drops trainer and StablePass posts from both the rows AND the
// exact count. This is the test that would have caught it — MUTATION-VERIFIED
// (see the ticket's verification steps): it fails RED if any select regains
// `horse:horse_id!inner(`.
describe("GET /api/admin/posts?sort=subject — all three subjects come back (ENG-1291 regression)", () => {
  it("returns all three subjects, and the exact count is not shrunk by the join", async () => {
    asAdmin();
    const rows = [
      { id: "p-horse", subject: "horse", horse_id: "h1", byline: null, subject_name: "Mahogany" },
      {
        id: "p-trainer",
        subject: "trainer",
        horse_id: null,
        byline: null,
        subject_name: "Chris Waller",
      },
      {
        id: "p-stablepass",
        subject: "stablepass",
        horse_id: null,
        byline: "Racing TV",
        // NOT the byline: the BE's `subject_name` stablepass arm is the
        // literal `'stablepass'` (ENG-1292's migration), which is what
        // `subjectLabel` renders as the NAME with the byline as the detail.
        subject_name: "stablepass",
      },
    ];
    state.tables.post = { select: { rows, count: 3 } };
    const r = await GET(new Request("http://t/api/admin/posts?sort=subject&dir=asc"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data).toHaveLength(3);
    expect(new Set(j.data.map((row: { id: string }) => row.id))).toEqual(
      new Set(["p-horse", "p-trainer", "p-stablepass"]),
    );
    // The count:"exact" total must not shrink — that is half the original bug.
    expect(j.meta.count).toBe(3);
  });
});

// ENG-963 rework. `?trainerId=` was shape-checked with `/^[0-9a-f-]{36}$/i`,
// which is not a uuid check — it accepts any 36-char run of hex-or-dash, so a
// string of 36 DASHES passed it and reached Postgres. There it 400s with
// `invalid input syntax for type uuid: "---…"`, and this route hands that
// message straight back via `fail("query_failed", error.message, 400)` — the
// exact schema-detail leak the comment above the check says it prevents.
// It is now `isUuid` (lib/uuid.ts), and these are the tests that would have
// caught it: none of the sort tests above ever passed a malformed id.
describe("GET /api/admin/posts — ?trainerId= is validated as a uuid", () => {
  const MALFORMED = [
    ["36 dashes — what the old regex let through", "-".repeat(36)],
    ["36 hex chars with no dashes", "9f1c7a2e4b3d4c8a9e172f5b6c0d8a41abcd"],
    ["dashes in the wrong places", "9f1c7a2e4-b3d-4c8a-9e17-2f5b6c0d8a4"],
    ["a PostgREST filter injection attempt", "1,id.gt.0"],
    ["an e2e seed id", "t1"],
  ] as const;

  it.each(MALFORMED)("%s is IGNORED, not sent to Postgres", async (_label, bad) => {
    asAdmin();
    state.tables.post = { select: { rows: [], count: 0 } };
    const r = await GET(
      new Request(`http://t/api/admin/posts?trainerId=${encodeURIComponent(bad)}`),
    );
    // 200 with the unscoped library, per the route's own comment: "Ignored
    // rather than rejected, so a bad bookmark shows the library."
    expect(r.status).toBe(200);
    expect(postEqs().some((e) => e.column === "source_trainer_id")).toBe(false);
  });

  it("a malformed id still returns a well-formed envelope, leaking no Postgres text", async () => {
    asAdmin();
    state.tables.post = { select: { rows: [{ id: "p1" }], count: 1 } };
    const r = await GET(new Request(`http://t/api/admin/posts?trainerId=${"-".repeat(36)}`));
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(JSON.stringify(body)).not.toMatch(/invalid input syntax|uuid|22P02/i);
  });

  it("a WELL-FORMED id is still applied — the guard did not just disable the filter", async () => {
    asAdmin();
    state.tables.post = { select: { rows: [], count: 0 } };
    const good = "9f1c7a2e-4b3d-4c8a-9e17-2f5b6c0d8a41";
    await GET(new Request(`http://t/api/admin/posts?trainerId=${good}`));
    expect(postEqs()).toContainEqual({
      table: "post",
      column: "source_trainer_id",
      value: good,
    });
  });

  it("an UPPERCASE uuid is accepted (Postgres is case-insensitive here)", async () => {
    asAdmin();
    state.tables.post = { select: { rows: [], count: 0 } };
    const good = "9F1C7A2E-4B3D-4C8A-9E17-2F5B6C0D8A41";
    await GET(new Request(`http://t/api/admin/posts?trainerId=${good}`));
    expect(postEqs().some((e) => e.column === "source_trainer_id")).toBe(true);
  });
});
