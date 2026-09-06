import { describe, it, expect } from "vitest";
import { makeFakeClient, blankState } from "./supabase-fake";

/**
 * ENG-993 — the fake is test infrastructure, so it needs its own tests.
 *
 * `neq is in ilike gt lt lte order range` were implemented as `() => b`: pure
 * no-ops that returned the builder and recorded nothing. Because the fake
 * resolves mutations from its per-table script and never consults the chain,
 * a conditional write recorded EXACTLY the same as an unconditional one — so
 * every test guarding a precondition passed with that precondition deleted.
 *
 * These tests pin the recording itself. If a comparator is ever reverted to a
 * no-op, the matching case here goes red instead of silently re-opening the
 * hole across all 29 test files that use this fake.
 */
describe("supabase-fake query builder records its filters", () => {
  const comparators = [
    { method: "neq", column: "status", value: "archived" },
    { method: "is", column: "mux_playback_id", value: null },
    { method: "in", column: "id", value: ["a", "b"] },
    { method: "ilike", column: "name", value: "%rose%" },
    { method: "gt", column: "views", value: 10 },
    { method: "gte", column: "sort_order", value: 3 },
    { method: "lt", column: "views", value: 99 },
    { method: "lte", column: "views", value: 50 },
  ] as const;

  for (const { method, column, value } of comparators) {
    it(`records .${method}() on the mutation that it guards`, () => {
      const state = blankState();
      const sb = makeFakeClient(state);
      const chain = sb.from("post").update({ touched: true }) as unknown as Record<
        string,
        (c: unknown, v: unknown) => unknown
      >;
      chain[method](column, value);

      expect(state.calls.mutations).toHaveLength(1);
      const [m] = state.calls.mutations;
      expect(m.table).toBe("post");
      expect(m.op).toBe("update");
      // `gte` predates ENG-993 and already carried `op`; the rest now match it.
      expect(m.filters).toEqual([{ column, value, op: method }]);
    });
  }

  it("keeps .eq() bare (no `op`), so existing filter assertions still hold", () => {
    const state = blankState();
    makeFakeClient(state).from("post").delete().eq("id", "p1");
    expect(state.calls.mutations[0].filters).toEqual([{ column: "id", value: "p1" }]);
  });

  it("records every filter on a multi-guard chain, in call order", () => {
    const state = blankState();
    makeFakeClient(state)
      .from("post")
      .update({ mux_playback_id: "pb_2" })
      .eq("id", "p1")
      .is("mux_playback_id", null);

    expect(state.calls.mutations[0].filters).toEqual([
      { column: "id", value: "p1" },
      { column: "mux_playback_id", value: null, op: "is" },
    ]);
  });

  it("carries filters chained BEFORE the mutation onto it", () => {
    const state = blankState();
    makeFakeClient(state).from("post").select("id").neq("status", "draft").delete();
    expect(state.calls.mutations[0].filters).toEqual([
      { column: "status", value: "draft", op: "neq" },
    ]);
  });

  // ENG-993 — the false-PASS direction. The filters array used to be shared by
  // reference across EVERY mutation from one `from()` builder, so a guard
  // belonging to the second write also showed up on the first: a precondition
  // assertion could pass for a write that never carried it. That is precisely
  // the "test passes with the guard deleted" failure this ticket removes, so
  // it must not be reintroduced by the fix itself.
  it("does not leak a later mutation's guard onto an earlier one", () => {
    const state = blankState();
    const chain = makeFakeClient(state).from("post");
    chain.update({ a: 1 }).eq("id", "p1");
    chain.delete().eq("id", "p2").is("archived_at", null);

    const [first, second] = state.calls.mutations;
    // The UPDATE never carried `.is(...)`, so it must not appear to.
    // `toEqual`, not `toContainEqual` — a containment matcher passes on an
    // array that has picked up EXTRA entries, which is the whole bug.
    expect(first.filters).toEqual([{ column: "id", value: "p1" }]);
    expect(second.filters).toEqual([
      { column: "id", value: "p2" },
      { column: "archived_at", value: null, op: "is" },
    ]);
  });

  // The mirror direction, and the dangerous one. The first attempt at this fix
  // re-seeded each mutation from the RUNNING filter array, which closed the
  // leak above but left this one wide open: a later mutation inherited the
  // earlier one's guards. An UNFILTERED `.delete()` — the statement that would
  // wipe the whole table — then recorded as though it carried a row selector
  // and a precondition, so a "we only deleted that one row" assertion passed
  // for a statement that deleted everything. Same false PASS, mirrored.
  it("does not leak an earlier mutation's guard onto a later, UNGUARDED one", () => {
    const state = blankState();
    const chain = makeFakeClient(state).from("post");
    chain.update({ a: 1 }).eq("id", "p1").is("archived_at", null);
    chain.delete(); // no filter at all

    const [first, second] = state.calls.mutations;
    expect(first.filters).toEqual([
      { column: "id", value: "p1" },
      { column: "archived_at", value: null, op: "is" },
    ]);
    // Must report itself for what it is: a DELETE with no WHERE clause.
    expect(second.filters).toEqual([]);
  });

  it("keeps filters chained BEFORE any mutation on every mutation off that builder", () => {
    const state = blankState();
    const chain = makeFakeClient(state).from("post");
    chain.eq("horse_id", "h1"); // scopes the builder, before either write
    chain.update({ a: 1 }).eq("id", "p1");
    chain.delete().eq("id", "p2");

    const [first, second] = state.calls.mutations;
    // Legitimately shared — it really did precede both — but each mutation
    // holds its OWN copy, so neither can mutate the other's record.
    expect(first.filters).toEqual([
      { column: "horse_id", value: "h1" },
      { column: "id", value: "p1" },
    ]);
    expect(second.filters).toEqual([
      { column: "horse_id", value: "h1" },
      { column: "id", value: "p2" },
    ]);
    expect(first.filters).not.toBe(second.filters);
  });

  describe("result-shaping calls are recorded, not treated as filters", () => {
    it("keeps .order()/.range() OUT of mutations[].filters", () => {
      const state = blankState();
      makeFakeClient(state)
        .from("post")
        .update({ touched: true })
        .eq("id", "p1")
        .order("created_at", { ascending: false })
        .range(0, 9);

      // Shaping a result set can never make a write conditional, so letting
      // these into `filters` would corrupt "which row did this target".
      expect(state.calls.mutations[0].filters).toEqual([{ column: "id", value: "p1" }]);
    });

    it("still records them on calls.modifiers rather than discarding them", () => {
      const state = blankState();
      makeFakeClient(state).from("post").select("id").order("created_at", { ascending: false }).range(0, 9);

      expect(state.calls.modifiers).toEqual([
        { table: "post", kind: "order", args: ["created_at", { ascending: false }] },
        { table: "post", kind: "range", args: [0, 9] },
      ]);
    });

    it("records order/range with fixed arity (omitted options read as undefined)", () => {
      const state = blankState();
      makeFakeClient(state).from("post").select("id").order("created_at");
      expect(state.calls.modifiers).toEqual([
        { table: "post", kind: "order", args: ["created_at", undefined] },
      ]);
    });
  });

  // Distinct from the "keeps .eq() bare" test above: that one only proves the
  // recorded SHAPE. This one proves POSITION — filters on both sides of the
  // `.delete()` land on it, in call order — which is what makes the fake
  // usable for the `.delete().eq(...)` idiom the routes actually write.
  it("records filters chained BEFORE and AFTER the mutation, in call order", () => {
    const state = blankState();
    makeFakeClient(state)
      .from("post")
      .eq("horse_id", "h1")
      .delete()
      .eq("id", "p1")
      .is("archived_at", null);

    expect(state.calls.mutations[0].filters).toEqual([
      { column: "horse_id", value: "h1" },
      { column: "id", value: "p1" },
      { column: "archived_at", value: null, op: "is" },
    ]);
  });

  it("blankState() starts with empty modifiers", () => {
    expect(blankState().calls.modifiers).toEqual([]);
  });
});
