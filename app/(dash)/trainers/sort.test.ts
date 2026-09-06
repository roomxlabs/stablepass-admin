import { describe, it, expect, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";
import {
  sortTrainerRows,
  trainerPostsHref,
  listTrainers,
  TRAINER_SORT_KEYS,
  type TrainerRow,
  type TrainerSort,
} from "./data";
import type { SortDir } from "../list-href";

function row(overrides: Partial<TrainerRow>): TrainerRow {
  return {
    id: "id",
    name: "name",
    displayName: "Name",
    slug: "slug",
    stableName: null,
    location: null,
    status: "active",
    photoUrl: null,
    marketingVisible: false,
    initials: "NA",
    contactEmail: null,
    horseCount: 0,
    lastPostAt: null,
    ...overrides,
  };
}

describe("sortTrainerRows", () => {
  const rows: TrainerRow[] = [
    row({ id: "a", displayName: "Zara Adams", stableName: "Zulu Stables", status: "onboarding", horseCount: 2, lastPostAt: "2026-08-01T00:00:00Z" }),
    row({ id: "b", displayName: "Amy Baker", stableName: null, status: "active", horseCount: 5, lastPostAt: null }),
    row({ id: "c", displayName: "Chris Waller", stableName: "Waller Racing", status: "active", horseCount: 5, lastPostAt: "2026-08-05T00:00:00Z" }),
  ];

  it.each(TRAINER_SORT_KEYS)("sorts by '%s' in both directions without dropping or duplicating rows", (key: TrainerSort) => {
    const asc = sortTrainerRows(rows, key, "asc");
    const desc = sortTrainerRows(rows, key, "desc");
    expect(new Set(asc.map((r) => r.id))).toEqual(new Set(["a", "b", "c"]));
    expect(new Set(desc.map((r) => r.id))).toEqual(new Set(["a", "b", "c"]));
  });

  it("trainer: orders by displayName A→Z / Z→A", () => {
    // Amy Baker(b) < Chris Waller(c) < Zara Adams(a)
    expect(sortTrainerRows(rows, "trainer", "asc").map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(sortTrainerRows(rows, "trainer", "desc").map((r) => r.id)).toEqual(["a", "c", "b"]);
  });

  it("stable: null stableName SINKS in both directions", () => {
    expect(sortTrainerRows(rows, "stable", "asc").at(-1)?.id).toBe("b");
    expect(sortTrainerRows(rows, "stable", "desc").at(-1)?.id).toBe("b");
  });

  it("horses: numeric order, ties break on displayName", () => {
    // b (5, Amy Baker) and c (5, Chris Waller) tie on horseCount; a (2) is lowest.
    expect(sortTrainerRows(rows, "horses", "asc").map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(sortTrainerRows(rows, "horses", "desc").map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("lastpost: compared as an epoch; null lastPostAt SINKS in both directions", () => {
    expect(sortTrainerRows(rows, "lastpost", "asc").at(-1)?.id).toBe("b");
    expect(sortTrainerRows(rows, "lastpost", "desc").at(-1)?.id).toBe("b");
    // Non-null values still order correctly.
    expect(sortTrainerRows(rows, "lastpost", "asc").map((r) => r.id).slice(0, 2)).toEqual(["a", "c"]);
    expect(sortTrainerRows(rows, "lastpost", "desc").map((r) => r.id).slice(0, 2)).toEqual(["c", "a"]);
  });

  it("status: alphabetical (active < onboarding), ties break on displayName", () => {
    expect(sortTrainerRows(rows, "status", "asc").map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("does NOT mutate the input array", () => {
    const copy = [...rows];
    sortTrainerRows(rows, "trainer", "asc");
    expect(rows).toEqual(copy);
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("sortTrainerRows(rows, '', dir) returns the rows unchanged (same reference)", () => {
    expect(sortTrainerRows(rows, "", "asc")).toBe(rows);
    expect(sortTrainerRows(rows, "", "desc")).toBe(rows);
  });
});

describe("trainerPostsHref", () => {
  it("returns /posts?trainerId=<encoded> when lastPostAt is set", () => {
    expect(trainerPostsHref("t1", "2026-08-01T00:00:00Z")).toBe("/posts?trainerId=t1");
  });

  it("encodes the trainer id", () => {
    expect(trainerPostsHref("t 1", "2026-08-01T00:00:00Z")).toBe("/posts?trainerId=t%201");
  });

  it("is null when lastPostAt is null — an empty scoped list is a dead end", () => {
    expect(trainerPostsHref("t1", null)).toBeNull();
  });
});

describe("listTrainers — sort wiring", () => {
  const state: FakeState = blankState();

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
        return b;
      },
    };
  }

  const orders: { table: string; args: unknown[] }[] = [];

  // SEED ORDER IS LOAD-BEARING. The fake does not implement PostgREST `order=`
  // — it hands rows back in the order they were seeded — so any assertion that
  // matches this order proves nothing. The original version of this block
  // seeded [t1(2 horses), t2(1)] and asserted `horses desc` === ["t1","t2"],
  // which held with `sortTrainerRows` deleted entirely.
  //
  // So: the seed order below is [t2, t1, t3] and NO asserted order equals it.
  //   horseCount   t1=2  t2=1  t3=0   → asc ["t3","t2","t1"], desc ["t1","t2","t3"]
  //   displayName  Amy Baker(t2) < Bianca Zeta(t3) < Chris Waller(t1)
  //   lastPostAt   t3 (Aug 9) > t1 (Aug 1); t2 has none and must sink
  // Every case asserts BOTH directions, so a comparator stuck on one direction
  // fails too.
  const SEED_ORDER = ["t2", "t1", "t3"];

  function trainer(id: string, displayName: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      name: displayName,
      display_name: displayName,
      slug: id,
      stable_name: `${displayName} Stables`,
      location: "Rosehill, NSW",
      status: "active",
      photo_url: null,
      marketing_visible: false,
      ...extra,
    };
  }

  function seed() {
    state.tables.trainer = {
      select: {
        rows: [
          trainer("t2", "Amy Baker"),
          trainer("t1", "Chris Waller", { marketing_visible: true }),
          trainer("t3", "Bianca Zeta"),
        ],
      },
    };
    state.tables.horse = {
      select: { rows: [{ trainer_id: "t1" }, { trainer_id: "t1" }, { trainer_id: "t2" }] },
    };
    state.tables.post = {
      select: {
        rows: [
          { source_trainer_id: "t1", published_at: "2026-08-01T00:00:00Z", created_at: "2026-07-01T00:00:00Z" },
          { source_trainer_id: "t3", published_at: "2026-08-09T00:00:00Z", created_at: "2026-07-01T00:00:00Z" },
        ],
      },
    };
    state.tables.trainer_contact = { select: { rows: [] } };
  }

  async function listIds(sort: TrainerSort | "", dir: SortDir) {
    seed();
    const sb = wrapClient(makeFakeClient(state)) as unknown as SupabaseClient;
    const { rows } = await listTrainers(sb, sort ? { sort, dir } : {});
    return rows.map((r) => r.id);
  }

  beforeEach(() => {
    Object.assign(state, blankState());
    orders.length = 0;
  });

  it("GUARD: the fake returns rows in seed order, so seed order is not an ordering", async () => {
    // If this ever fails because the fake grew real `order=` support, the
    // "differs from seed order" argument below needs revisiting — but the
    // assertions themselves stay valid, since they pin the rendered order.
    expect(await listIds("", "asc")).toEqual(SEED_ORDER);
  });

  it("{sort:'trainer'} issues an .order() on the trainer table, DB column 'name'", async () => {
    seed();
    const sb = wrapClient(makeFakeClient(state)) as unknown as SupabaseClient;
    await listTrainers(sb, { sort: "trainer", dir: "desc" });
    const trainerOrders = orders.filter((o) => o.table === "trainer");
    expect(trainerOrders[0]).toEqual({ table: "trainer", args: ["name", { ascending: false }] });
  });

  it("{sort:'trainer'} ALSO re-sorts the merged rows by displayName, both directions", async () => {
    // Not redundant with the .order() assertion above: the DB ordered the raw
    // `name`, the table renders `display_name ?? name`, and this fake ignores
    // `order=` entirely — so this is the assertion that dies if the
    // `sortTrainerRows(rows, sort, dir)` call at the end of listTrainers goes.
    expect(await listIds("trainer", "asc")).toEqual(["t2", "t3", "t1"]);
    expect(await listIds("trainer", "desc")).toEqual(["t1", "t3", "t2"]);
  });

  it("{sort:'horses'} orders by the DERIVED horseCount, both directions", async () => {
    expect(await listIds("horses", "desc")).toEqual(["t1", "t2", "t3"]);
    expect(await listIds("horses", "asc")).toEqual(["t3", "t2", "t1"]);
    // And the counts themselves are the merge's, not the seed's.
    seed();
    const sb = wrapClient(makeFakeClient(state)) as unknown as SupabaseClient;
    const { rows } = await listTrainers(sb, { sort: "horses", dir: "desc" });
    expect(rows.map((r) => r.horseCount)).toEqual([2, 1, 0]);
  });

  it("{sort:'lastpost'} orders by the DERIVED lastPostAt, and the trainer with none sinks", async () => {
    expect(await listIds("lastpost", "desc")).toEqual(["t3", "t1", "t2"]);
    // t2 has no post at all, so it sinks in ASC too rather than leading it.
    expect(await listIds("lastpost", "asc")).toEqual(["t1", "t3", "t2"]);
  });

  it("{sort:'stable'} and {sort:'status'} also come back re-sorted, not in seed order", async () => {
    // Stable names track the display names here ("<name> Stables").
    expect(await listIds("stable", "asc")).toEqual(["t2", "t3", "t1"]);
    expect(await listIds("stable", "desc")).toEqual(["t1", "t3", "t2"]);
    // All three are `active`, so `status` falls through to its displayName tiebreak.
    expect(await listIds("status", "asc")).toEqual(["t2", "t3", "t1"]);
  });
});
