import { describe, it, expect, beforeEach } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";
import { recordCalls, blankRecord, selectFor, type CallRecord } from "@/lib/testing/call-recorder";
import { HORSE_LIST_SELECT, fetchHorseForEdit, fetchHorses, fetchTrainerOptions } from "../data";

/* eslint-disable @typescript-eslint/no-explicit-any */

const state: FakeState = blankState();
const rec: CallRecord = blankRecord();
const sb = () => recordCalls(makeFakeClient(state), rec) as any;

beforeEach(() => {
  Object.assign(state, blankState());
  Object.assign(rec, blankRecord());
});

describe("HORSE_LIST_SELECT — the projection", () => {
  // `tsc` cannot see a too-narrow `.select()`: dropping a column from the
  // projection string compiles perfectly and silently blanks the screen. These
  // assertions are the only thing standing between that and production.
  it("names both computed columns", () => {
    expect(HORSE_LIST_SELECT).toContain("horse_age");
    expect(HORSE_LIST_SELECT).toContain("horse_description");
  });

  it("names the stored sex fields too", () => {
    expect(HORSE_LIST_SELECT).toContain("sex");
    expect(HORSE_LIST_SELECT).toContain("is_gelded");
  });

  it("keeps the embed markers the list and the e2e mock depend on", () => {
    expect(HORSE_LIST_SELECT).toContain("trainer:trainer_id(display_name)");
    expect(HORSE_LIST_SELECT).toContain("follows:follow(count)");
    expect(HORSE_LIST_SELECT).toContain("posts:post(count)");
  });

  it("asks for no owner column (guardrail: no owner PII)", () => {
    expect(HORSE_LIST_SELECT).not.toMatch(/owner/i);
  });

  it("is the string fetchHorses actually sends", async () => {
    state.tables.horse = { select: { rows: [] } };
    await fetchHorses(sb(), "");
    expect(selectFor(rec, "horse")).toBe(HORSE_LIST_SELECT);
  });
});

describe("fetchHorses", () => {
  it("returns the rows", async () => {
    state.tables.horse = { select: { rows: [{ id: "h1" }, { id: "h2" }] } };
    const rows = await fetchHorses(sb(), "");
    expect(rows.map((r) => r.id)).toEqual(["h1", "h2"]);
  });

  it("THROWS on a query error rather than returning an empty list", async () => {
    // A swallowed error renders an RLS regression as "No horses yet" — the one
    // failure mode the admin gate exists to make impossible.
    state.tables.horse = { select: { error: { code: "42501" } } };
    await expect(fetchHorses(sb(), "")).rejects.toThrow(/42501/);
  });

  it("throws on a failed trainer lookup during search too", async () => {
    state.tables.trainer = { select: { error: { code: "42501" } } };
    state.tables.horse = { select: { rows: [] } };
    await expect(fetchHorses(sb(), "waller")).rejects.toThrow(/42501/);
  });

  it("treats a null data set as empty, not as a crash", async () => {
    state.tables.horse = { select: {} };
    await expect(fetchHorses(sb(), "")).resolves.toEqual([]);
  });

  it("strips PostgREST logical-tree separators from the search term", async () => {
    state.tables.trainer = { select: { rows: [] } };
    state.tables.horse = { select: { rows: [] } };
    await fetchHorses(sb(), "a,b(c)");
    // Scoped to the user's term: the OR tree legitimately contains parens of its
    // own (`trainer_id.in.(…)`) whenever a trainer matches, so asserting "no
    // parens anywhere" would go red on a non-bug.
    const term = state.calls.or[0].split(",")[0];
    expect(term).not.toMatch(/[()]/);
    expect(state.calls.or[0]).toContain("display_name.ilike.%a b c %");
  });
});

describe("fetchTrainerOptions", () => {
  it("returns the rows", async () => {
    state.tables.trainer = { select: { rows: [{ id: "t1", display_name: "Chris Waller", stable_name: null }] } };
    await expect(fetchTrainerOptions(sb())).resolves.toHaveLength(1);
  });

  it("THROWS on a query error rather than rendering an empty trainer dropdown", async () => {
    // An empty dropdown reads as "no trainers exist" and invites the operator to
    // create a duplicate — the same swallowed-error class as the list screen.
    state.tables.trainer = { select: { error: { code: "42501" } } };
    await expect(fetchTrainerOptions(sb())).rejects.toThrow(/42501/);
  });
});

describe("fetchHorseForEdit", () => {
  it("returns the row and scopes the read to the requested id", async () => {
    state.tables.horse = { select: { single: { id: "h1", sex: "male", is_gelded: true } } };
    await expect(fetchHorseForEdit(sb(), "h1")).resolves.toMatchObject({ sex: "male", is_gelded: true });
    expect(rec.filters).toContain("horse.id=h1");
  });

  it("returns null for a genuine not-found", async () => {
    state.tables.horse = { select: { single: null } };
    await expect(fetchHorseForEdit(sb(), "nope")).resolves.toBeNull();
  });

  it("THROWS on a query error instead of degrading to a 404", async () => {
    // notFound() on a failed read would tell the operator the horse does not
    // exist when the truth is that the policy broke.
    state.tables.horse = { select: { error: { code: "42501" } } };
    await expect(fetchHorseForEdit(sb(), "h1")).rejects.toThrow(/42501/);
  });
});
