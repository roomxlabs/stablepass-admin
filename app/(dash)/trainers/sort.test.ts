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

  function seed() {
    state.tables.trainer = {
      select: {
        rows: [
          { id: "t1", name: "Chris Waller", display_name: "Chris Waller", slug: "chris-waller", stable_name: "Chris Waller Racing", location: "Rosehill, NSW", status: "active", photo_url: null, marketing_visible: true },
          { id: "t2", name: "Amy Baker", display_name: "Amy Baker", slug: "amy-baker", stable_name: "Baker Stables", location: "Warwick Farm, NSW", status: "active", photo_url: null, marketing_visible: false },
        ],
      },
    };
    state.tables.horse = { select: { rows: [{ trainer_id: "t1" }, { trainer_id: "t1" }, { trainer_id: "t2" }] } };
    state.tables.post = { select: { rows: [] } };
    state.tables.trainer_contact = { select: { rows: [] } };
  }

  beforeEach(() => {
    Object.assign(state, blankState());
    orders.length = 0;
  });

  it("{sort:'trainer', dir:'desc'} issues an .order() on the trainer table, DB column 'name'", async () => {
    seed();
    const sb = wrapClient(makeFakeClient(state)) as unknown as SupabaseClient;
    await listTrainers(sb, { sort: "trainer", dir: "desc" });
    const trainerOrders = orders.filter((o) => o.table === "trainer");
    expect(trainerOrders[0]).toEqual({ table: "trainer", args: ["name", { ascending: false }] });
  });

  it("{sort:'horses', dir:'desc'} returns rows ordered by horseCount desc (derived, sorted in JS)", async () => {
    seed();
    const sb = wrapClient(makeFakeClient(state)) as unknown as SupabaseClient;
    const { rows } = await listTrainers(sb, { sort: "horses", dir: "desc" });
    expect(rows.map((r) => r.id)).toEqual(["t1", "t2"]);
    expect(rows.map((r) => r.horseCount)).toEqual([2, 1]);
  });
});
