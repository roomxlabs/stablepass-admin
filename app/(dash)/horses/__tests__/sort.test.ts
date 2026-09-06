import { describe, it, expect, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";
import {
  embedCount,
  fetchHorseLastPostMap,
  fetchHorses,
  HORSE_SORT_KEYS,
  sortHorseRows,
  type HorseRow,
  type HorseSort,
} from "../data";

// ENG-963 rework. The Horses sort shipped with NO unit coverage: hardcoding the
// `HORSE_DB_ORDER` lookup in `fetchHorses` so `?sort=name` was ignored left the
// whole suite green, and the only "proof" was an e2e assertion running against
// a mock that does not implement PostgREST `order=` at all — so it could not
// distinguish sorted output from unsorted. This file is the missing coverage:
// the DB half (which `.order()` actually goes out) and the JS half
// (`sortHorseRows`, extracted from page.tsx precisely so it can be reached).

/* eslint-disable @typescript-eslint/no-explicit-any */

const state: FakeState = blankState();
const orders: { table: string; args: unknown[] }[] = [];

function spyClient(client: ReturnType<typeof makeFakeClient>) {
  return {
    ...client,
    from: (t: string) => {
      const b = client.from(t);
      const origOrder = b.order;
      (b as any).order = (...a: unknown[]) => {
        orders.push({ table: t, args: a });
        return (origOrder as any)(...a);
      };
      return b;
    },
  };
}

const sb = () => spyClient(makeFakeClient(state)) as unknown as SupabaseClient;

beforeEach(() => {
  Object.assign(state, blankState());
  orders.length = 0;
});

function horse(id: string, display_name: string, followers: number | null): HorseRow {
  return {
    id,
    display_name,
    racing_name: null,
    stable_name: null,
    sex: null,
    is_gelded: null,
    horse_age: null,
    horse_description: null,
    colour: null,
    foaling_year: null,
    status: "active",
    training_status: "racing",
    photo_url: null,
    trainer: null,
    follows: followers === null ? null : [{ count: followers }],
    posts: null,
  };
}

// Seed order is deliberately NOT any of the asserted orders, so an assertion
// cannot hold by accident of how the rows were written down.
//   followers  h1=10  h2=3  h3=10  h4=0
//   name       Anchor(h4) < Black Caviar(h2) < Winx(h1) < Zzz Horse(h3)
const ROWS: HorseRow[] = [
  horse("h2", "Black Caviar", 3),
  horse("h4", "Anchor", 0),
  horse("h1", "Winx", 10),
  horse("h3", "Zzz Horse", 10),
];
const SEED_ORDER = ["h2", "h4", "h1", "h3"];

const LAST_POST = new Map<string, string>([
  ["h1", "2026-08-01T00:00:00Z"],
  ["h2", "2026-08-09T00:00:00Z"],
  // h3 and h4 have never been posted about.
]);

describe("fetchHorses — which .order() goes to Postgres", () => {
  // The mutation this pins: hardcode the HORSE_DB_ORDER lookup so `?sort=name`
  // silently falls back to `created_at desc`. Before this file, that passed.
  it.each([
    ["name", ["display_name", { ascending: true }]],
    ["newest", ["created_at", { ascending: false }]],
  ] as const)("sort '%s' orders by the matching DB column", async (sort, expected) => {
    state.tables.horse = { select: { rows: [] } };
    await fetchHorses(sb(), "", null, sort as HorseSort);
    expect(orders.filter((o) => o.table === "horse")[0]?.args).toEqual(expected);
  });

  it.each(["followers", "lastpost"] as const)(
    "sort '%s' is NOT orderable in Postgres, so the query keeps the default order",
    async (sort) => {
      state.tables.horse = { select: { rows: [] } };
      await fetchHorses(sb(), "", null, sort as HorseSort);
      expect(orders.filter((o) => o.table === "horse")[0]?.args).toEqual([
        "created_at",
        { ascending: false },
      ]);
    },
  );

  it("an absent sort keeps the historical default, created_at desc", async () => {
    state.tables.horse = { select: { rows: [] } };
    await fetchHorses(sb(), "");
    expect(orders.filter((o) => o.table === "horse")[0]?.args).toEqual([
      "created_at",
      { ascending: false },
    ]);
  });

  it("every declared sort key issues exactly one .order() on horse", async () => {
    // A key added to HORSE_SORT_KEYS without a story for how it is ordered
    // would otherwise ship as a silent no-op.
    for (const key of HORSE_SORT_KEYS) {
      orders.length = 0;
      state.tables.horse = { select: { rows: [] } };
      await fetchHorses(sb(), "", null, key);
      expect(orders.filter((o) => o.table === "horse")).toHaveLength(1);
    }
  });

  it("the trainer scope is applied alongside the sort, not instead of it", async () => {
    state.tables.horse = { select: { rows: [] } };
    await fetchHorses(sb(), "", "9f1c7a2e-4b3d-4c8a-9e17-2f5b6c0d8a41", "name");
    expect(orders.filter((o) => o.table === "horse")[0]?.args).toEqual([
      "display_name",
      { ascending: true },
    ]);
  });
});

describe("sortHorseRows", () => {
  it("GUARD: the two DB-ordered keys are returned UNTOUCHED, same reference", () => {
    // Re-sorting them here would fight Postgres and cost a copy on every load.
    expect(sortHorseRows(ROWS, "name", LAST_POST)).toBe(ROWS);
    expect(sortHorseRows(ROWS, "newest", LAST_POST)).toBe(ROWS);
    expect(sortHorseRows(ROWS, "", LAST_POST)).toBe(ROWS);
    expect(ROWS.map((r) => r.id)).toEqual(SEED_ORDER);
  });

  it("followers: biggest first, ties broken on name — and NOT the seed order", () => {
    const ids = sortHorseRows(ROWS, "followers", null).map((r) => r.id);
    expect(ids).toEqual(["h1", "h3", "h2", "h4"]);
    expect(ids).not.toEqual(SEED_ORDER);
  });

  it("followers: a 0 count is a real value and sorts LAST, not as a null", () => {
    expect(sortHorseRows(ROWS, "followers", null).at(-1)?.id).toBe("h4");
  });

  it("followers: a missing follows embed counts as 0", () => {
    const rows = [horse("a", "Aaa", null), horse("b", "Bbb", 2)];
    expect(sortHorseRows(rows, "followers", null).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("lastpost: most recent first, and horses with no post SINK", () => {
    const ids = sortHorseRows(ROWS, "lastpost", LAST_POST).map((r) => r.id);
    expect(ids).toEqual(["h2", "h1", "h4", "h3"]);
    // The two with no post are last, ordered by name between themselves.
    expect(ids.slice(2)).toEqual(["h4", "h3"]);
    expect(ids).not.toEqual(SEED_ORDER);
  });

  it("lastpost: a null map means nobody has posted, so it degrades to name order", () => {
    expect(sortHorseRows(ROWS, "lastpost", null).map((r) => r.id)).toEqual([
      "h4",
      "h2",
      "h1",
      "h3",
    ]);
  });

  it("does not mutate its input", () => {
    const before = ROWS.map((r) => r.id);
    sortHorseRows(ROWS, "followers", LAST_POST);
    sortHorseRows(ROWS, "lastpost", LAST_POST);
    expect(ROWS.map((r) => r.id)).toEqual(before);
  });

  it("keeps every row exactly once, for every sort key", () => {
    for (const key of HORSE_SORT_KEYS) {
      const out = sortHorseRows(ROWS, key, LAST_POST);
      expect(out).toHaveLength(ROWS.length);
      expect(new Set(out.map((r) => r.id))).toEqual(new Set(SEED_ORDER));
    }
  });
});

describe("fetchHorseLastPostMap", () => {
  it("keeps the MOST RECENT post per horse, not the last row read", () => {
    state.tables.post = {
      select: {
        rows: [
          { horse_id: "h1", published_at: "2026-08-09T00:00:00Z", created_at: "2026-07-01T00:00:00Z" },
          { horse_id: "h1", published_at: "2026-08-01T00:00:00Z", created_at: "2026-07-01T00:00:00Z" },
        ],
      },
    };
    return fetchHorseLastPostMap(sb()).then((m) => {
      expect(m.get("h1")).toBe("2026-08-09T00:00:00Z");
    });
  });

  it("falls back to created_at when a post has not been published", async () => {
    state.tables.post = {
      select: { rows: [{ horse_id: "h2", published_at: null, created_at: "2026-08-03T00:00:00Z" }] },
    };
    const m = await fetchHorseLastPostMap(sb());
    expect(m.get("h2")).toBe("2026-08-03T00:00:00Z");
  });

  it("skips rows with no horse_id, and returns an empty map for no posts", async () => {
    state.tables.post = {
      select: { rows: [{ horse_id: null, published_at: null, created_at: "2026-08-03T00:00:00Z" }] },
    };
    expect(await fetchHorseLastPostMap(sb())).toEqual(new Map());
    state.tables.post = { select: { rows: [] } };
    expect(await fetchHorseLastPostMap(sb())).toEqual(new Map());
  });

  it("THROWS on a query error rather than returning an empty map", async () => {
    // Same rule as fetchHorses: a swallowed error would render "never posted"
    // for every horse, which is a wrong answer dressed as a real one.
    state.tables.post = { select: { error: { code: "42501" } } };
    await expect(fetchHorseLastPostMap(sb())).rejects.toThrow(/42501/);
  });

  it("feeds sortHorseRows end to end", async () => {
    state.tables.post = {
      select: {
        rows: [
          { horse_id: "h1", published_at: "2026-08-01T00:00:00Z", created_at: "2026-07-01T00:00:00Z" },
          { horse_id: "h2", published_at: "2026-08-09T00:00:00Z", created_at: "2026-07-01T00:00:00Z" },
        ],
      },
    };
    const map = await fetchHorseLastPostMap(sb());
    expect(sortHorseRows(ROWS, "lastpost", map).map((r) => r.id)).toEqual(["h2", "h1", "h4", "h3"]);
  });
});

describe("embedCount", () => {
  it("reads a PostgREST count embed, defaulting to 0", () => {
    expect(embedCount([{ count: 7 }])).toBe(7);
    expect(embedCount([])).toBe(0);
    expect(embedCount(null)).toBe(0);
  });
});
