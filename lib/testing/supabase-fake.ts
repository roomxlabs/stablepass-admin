/* eslint-disable @typescript-eslint/no-explicit-any */
// Test-support only: a scriptable stand-in for the Supabase server client so
// `app/api/admin/posts/*` route handlers can be unit-tested without a live
// backend. Tests `vi.mock("@/lib/supabase/server")` to return `makeFakeClient(state)`
// and drive results per table via `state.tables`. Not imported by app code.

export type ScriptResult = { single?: any; rows?: any[]; count?: number; error?: any };

/**
 * One comparator recorded off a query chain (ENG-993).
 *
 * `op` names WHICH comparator it was, so a test can prove a write was guarded
 * by `.is(col, null)` rather than merely that some filter was present. `eq` is
 * the one exception and records BARE (no `op`) — four pre-existing tests assert
 * `toEqual([{ column, value }])`, so that is load-bearing, not an oversight.
 */
export type Filter = { column: string; value: any; op?: string };

/** One recorded insert/update/delete/upsert. */
export type MutationRecord = {
  table: string;
  op: "insert" | "update" | "delete" | "upsert";
  payload: any;
  /**
   * The upsert's conflict target (e.g. `{ onConflict: "post_id,sort_order" }`),
   * so a test can prove the arbiter is what the writer actually needs
   * (ENG-748) and not just that SOME upsert happened. `insert`/`update`/
   * `delete` never carry one, hence optional.
   */
  options?: any;
  /**
   * The filters the chain carried, so a test can prove WHICH row a mutation
   * targeted and WHAT precondition guarded it. Without this a rollback
   * assertion is satisfied by a `.delete()` with no filter at all — i.e. by a
   * statement that would delete the whole table.
   *
   * Each mutation gets its OWN array (see `makeBuilder`): two mutations off one
   * `from()` builder never share or inherit filters, in either direction.
   */
  filters: Filter[];
};

export type TableScript = {
  // Result for a read chain (`.select(...).eq(...).single()` / awaited list).
  select?: ScriptResult;
  // Result once `.insert/.update/.delete` was called on the chain.
  mutate?: ScriptResult;
};

export type FakeState = {
  user: { id: string; email?: string } | null;
  // Assurance level the fake session reports (ENG-370). requireAdmin() now
  // requires aal2, so this defaults to "aal2" and every pre-existing route test
  // keeps asserting what it was written to assert. Set it to "aal1" to drive
  // the 403 `mfa_required` branch.
  aal: "aal1" | "aal2";
  tables: Record<string, TableScript>;
  functions: Record<string, { data?: any; error?: any }>;
  rpcs: Record<string, { data?: any; error?: any }>;
  storage: { signed?: { data?: any; error?: any } };
  calls: {
    functions: { name: string; body: any }[];
    or: string[];
    from: string[];
    rpc: { name: string; args: any }[];
    /**
     * The PAYLOAD of every insert/update/delete, per table (ENG-611).
     *
     * The builder used to swallow its arguments, which meant a test could only
     * ever assert that a mutation did not error — never that it wrote the
     * right thing. A route that inserted the wrong `type`, or forgot to record
     * `media_url`, passed just as green as a correct one. Recording the
     * payload is what lets a test guard the write itself.
     */
    mutations: MutationRecord[];
    /**
     * Result-SHAPING calls (`.order()` / `.range()`), per table (ENG-993).
     *
     * These are not filters — they cannot make a mutation conditional — so
     * they must not land in `mutations[].filters`. They are recorded here
     * instead of being dropped, so that of the methods this builder DOES
     * implement, none which filters or shapes a result discards its arguments,
     * and so a paging/sort assertion has something to read.
     *
     * `args` has fixed arity: `.order("created_at")` records
     * `["created_at", undefined]`, not `["created_at"]`.
     *
     * Scope note — this is NOT a claim that the fake records everything.
     * `select()` still drops its column list (and `{ count, head }`), `or()`
     * keeps only the expression, and `insert`/`update`/`delete` ignore their
     * options argument. `limit()` is not implemented AT ALL (though
     * `lib/dashboard/queries.ts` calls it) — an unimplemented method throws
     * loudly rather than passing silently, so it cannot produce a false PASS,
     * but a test that needs it must add it. Those gaps are unused by the
     * assertions this fake supports; add recording when a test needs to prove
     * one.
     */
    modifiers: { table: string; kind: "order" | "range"; args: any[] }[];
    /** Storage signed-upload targets requested, so "text makes no Storage call" is provable. */
    storage: { bucket: string; path: string }[];
  };
};

type Builder = {
  select: (...a: any[]) => Builder;
  insert: (...a: any[]) => Builder;
  update: (...a: any[]) => Builder;
  // ENG-748: `post_media` is written with `.upsert(rows, { onConflict })`, not
  // `.insert()` — a set that already has rows at those ordinals must overwrite
  // them, not 23505. Kept as its own method (mirroring insert) rather than
  // folded into it, so a test can tell the two calls apart on `op`.
  upsert: (payload?: any, options?: any) => Builder;
  delete: (...a: any[]) => Builder;
  eq: (...a: any[]) => Builder;
  neq: (...a: any[]) => Builder;
  is: (...a: any[]) => Builder;
  in: (...a: any[]) => Builder;
  ilike: (...a: any[]) => Builder;
  or: (expr: string, ...a: any[]) => Builder;
  order: (...a: any[]) => Builder;
  range: (...a: any[]) => Builder;
  gt: (...a: any[]) => Builder;
  gte: (...a: any[]) => Builder;
  lt: (...a: any[]) => Builder;
  lte: (...a: any[]) => Builder;
  single: () => Promise<{ data: any; error: any }>;
  maybeSingle: () => Promise<{ data: any; error: any }>;
  then: (
    resolve: (v: { data: any; error: any; count: number | null }) => any,
    reject?: (e: any) => any,
  ) => any;
};

function makeBuilder(state: FakeState, table: string): Builder {
  let op: "select" | "mutate" = "select";
  // Filters chained BEFORE any mutation. They legitimately apply to every
  // mutation on this builder, so each mutation record is seeded from a fresh
  // COPY of this — never from the previous mutation's (still-growing) array.
  const base: Filter[] = [];
  // Where comparators push right now. Aliases `base` until the first mutation,
  // then points at that mutation's own record array — so `.eq()` chained AFTER
  // `.delete()`/`.update()` still lands on the mutation it belongs to.
  //
  // ENG-993: this used to be ONE array shared by every mutation off a single
  // `from()`, which leaked guards in BOTH directions — a `.is(...)` belonging
  // to the second write appeared on the first, and the second write inherited
  // the first's. The second direction is the dangerous one: an UNFILTERED
  // `.delete()` (the statement that would wipe the table) recorded as though
  // it carried a row selector and a precondition. Either way a test asserts a
  // guard on a write that never carried it — the exact false PASS this ticket
  // exists to remove, so it must not survive in the fix. (Found by fresh-eyes
  // review of the first attempt, which only closed the backward direction.)
  let filters: Filter[] = base;
  const script = () => state.tables[table] ?? {};
  // Give this mutation a FRESH array seeded from `base` (the pre-mutation
  // filters only) and chain into it — so filters chained after the mutation
  // land on it, an earlier mutation's record stays frozen at what it actually
  // carried, and a later mutation does NOT inherit the earlier one's guards.
  //
  // The param is `kind`, not `op`, to avoid shadowing the enclosing
  // `let op: "select" | "mutate"` — the callers set that before calling here,
  // and a shadowed name would make a future `op = "mutate"` moved inside this
  // helper silently assign the parameter instead.
  const recordMutation = (
    kind: "insert" | "update" | "delete" | "upsert",
    payload: any,
    options?: any,
  ) => {
    filters = [...base];
    const record: MutationRecord = { table, op: kind, payload, filters };
    if (options !== undefined) record.options = options;
    state.calls.mutations.push(record);
  };
  const pick = (): ScriptResult => (op === "mutate" ? script().mutate : script().select) ?? {};
  const b: Builder = {
    select: () => b,
    insert: (payload?: any) => {
      op = "mutate";
      recordMutation("insert", payload);
      return b;
    },
    update: (payload?: any) => {
      op = "mutate";
      recordMutation("update", payload);
      return b;
    },
    // Mirrors `insert` exactly (same op-flip, same script table), but records
    // `op: "upsert"` and the options arg — the arbiter is the whole point of
    // calling this instead of `.insert()` (ENG-748), so it has to be provable.
    upsert: (payload?: any, options?: any) => {
      op = "mutate";
      recordMutation("upsert", payload, options);
      return b;
    },
    delete: () => {
      op = "mutate";
      recordMutation("delete", undefined);
      return b;
    },
    eq: (column?: any, value?: any) => {
      filters.push({ column, value });
      return b;
    },
    // ENG-993: every comparator below records its filter. They used to be
    // `() => b` — pure no-ops — which meant the chain's preconditions were
    // invisible to a test, so a conditional mutation passed its tests with the
    // guard DELETED. `.update(...).eq("id", x).is("col", null)` and
    // `.update(...).eq("id", x)` recorded identically, i.e. the only thing
    // stopping a lost-update race was untested and un-pinnable. Each records
    // `op` (unlike `eq`, which stays bare for back-compat with the existing
    // `toEqual([{ column, value }])` assertions) so a test can prove WHICH
    // comparator guarded the write, not merely that some filter was present.
    neq: (column?: any, value?: any) => {
      filters.push({ column, value, op: "neq" });
      return b;
    },
    is: (column?: any, value?: any) => {
      filters.push({ column, value, op: "is" });
      return b;
    },
    // ENG-950 landed this one first, for the same reason and in the same
    // shape. A conditional UPDATE is the repo's idiom for closing a TOCTOU
    // race — `.update(...).eq("id", id).in("status", ["draft","scheduled"])`
    // is what makes two concurrent publishes resolve to one winner instead of
    // both dispatching a push to every member. While `in` was a no-op that
    // guard was pinned by NOTHING: deleting `.in(...)` from the publish route
    // left the whole publish suite green, because the mutate result comes from
    // the script and never depended on the filter. `value` carries the array.
    in: (column?: any, value?: any) => {
      filters.push({ column, value, op: "in" });
      return b;
    },
    ilike: (column?: any, value?: any) => {
      filters.push({ column, value, op: "ilike" });
      return b;
    },
    or: (expr: string) => { state.calls.or.push(expr); return b; },
    // `order` and `range` are NOT filters — they shape/paginate a result set
    // and can never make a mutation conditional, so they are deliberately not
    // pushed into `filters` (doing so would corrupt the "which row did this
    // write target" assertions). They are still recorded, on `calls.modifiers`,
    // rather than dropped (ENG-993). See the `modifiers` doc comment for what
    // this fake still does NOT record (`select` columns, `or` options, and the
    // insert/update/delete options arg).
    order: (column?: any, options?: any) => {
      state.calls.modifiers.push({ table, kind: "order", args: [column, options] });
      return b;
    },
    range: (from?: any, to?: any) => {
      state.calls.modifiers.push({ table, kind: "range", args: [from, to] });
      return b;
    },
    gt: (column?: any, value?: any) => {
      filters.push({ column, value, op: "gt" });
      return b;
    },
    // Records its filter because ENG-748's trailing-set trim is a
    // `.delete().eq(post_id).gte(sort_order, n)` — without this a test
    // asserting "the tail was trimmed from the right ordinal" has nothing to
    // read the `n` off, and a trim that dropped the whole set (gte 0) would
    // look identical to a correct one. (It was the ONLY comparator doing this
    // until ENG-993 made the rest follow the same idiom.)
    gte: (column?: any, value?: any) => {
      filters.push({ column, value, op: "gte" });
      return b;
    },
    lt: (column?: any, value?: any) => {
      filters.push({ column, value, op: "lt" });
      return b;
    },
    lte: (column?: any, value?: any) => {
      filters.push({ column, value, op: "lte" });
      return b;
    },
    single: async () => ({ data: pick().single ?? null, error: pick().error ?? null }),
    maybeSingle: async () => ({ data: pick().single ?? null, error: pick().error ?? null }),
    then: (resolve, reject) => {
      const p = pick();
      return Promise.resolve({
        data: p.rows ?? null,
        error: p.error ?? null,
        count: p.count ?? null,
      }).then(resolve, reject);
    },
  };
  return b;
}

export function makeFakeClient(state: FakeState) {
  return {
    auth: {
      getUser: async () => ({ data: { user: state.user }, error: null }),
      // ENG-370: the admin gate reads the assurance level via Supabase's MFA
      // API. Without this the gate's try/catch would see a TypeError and fail
      // closed, 403-ing every route test.
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: state.aal, nextLevel: "aal2", currentAuthenticationMethods: [] },
          error: null,
        }),
      },
    },
    from: (table: string) => {
      state.calls.from.push(table);
      return makeBuilder(state, table);
    },
    functions: {
      invoke: async (name: string, opts?: { body?: any }) => {
        state.calls.functions.push({ name, body: opts?.body });
        return state.functions[name] ?? { data: { notificationsSent: 0 }, error: null };
      },
    },
    rpc: async (name: string, args?: any) => {
      state.calls.rpc.push({ name, args });
      return state.rpcs[name] ?? { data: [], error: null };
    },
    storage: {
      from: (bucket: string) => ({
        createSignedUploadUrl: async (path: string) => {
          state.calls.storage.push({ bucket, path });
          return (
            state.storage.signed ?? {
              data: { signedUrl: `https://storage.local/${bucket}/${path}`, token: "tok", path },
              error: null,
            }
          );
        },
        // ENG-825 — BFF poster route signs the new poster_url for display.
        createSignedUrl: async (path: string) => {
          state.calls.storage.push({ bucket, path });
          return (
            state.storage.signed ?? {
              data: { signedUrl: `https://storage.local/${bucket}/${path}` },
              error: null,
            }
          );
        },
        createSignedUrls: async (paths: string[]) => {
          for (const path of paths) state.calls.storage.push({ bucket, path });
          return {
            data: paths.map((path) => ({
              path,
              signedUrl: `https://storage.local/${bucket}/${path}`,
            })),
            error: null,
          };
        },
      }),
    },
  };
}

export function blankState(): FakeState {
  return {
    user: null,
    aal: "aal2",
    tables: {},
    functions: {},
    rpcs: {},
    storage: {},
    calls: { functions: [], or: [], from: [], rpc: [], mutations: [], modifiers: [], storage: [] },
  };
}
