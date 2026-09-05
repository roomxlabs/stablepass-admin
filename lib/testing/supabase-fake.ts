/* eslint-disable @typescript-eslint/no-explicit-any */
// Test-support only: a scriptable stand-in for the Supabase server client so
// `app/api/admin/posts/*` route handlers can be unit-tested without a live
// backend. Tests `vi.mock("@/lib/supabase/server")` to return `makeFakeClient(state)`
// and drive results per table via `state.tables`. Not imported by app code.

export type ScriptResult = { single?: any; rows?: any[]; count?: number; error?: any };

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
    mutations: {
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
       * The `.eq()` filters the chain carried, so a test can prove WHICH row a
       * mutation targeted. Without this a rollback assertion is satisfied by a
       * `.delete()` with no filter at all — i.e. by a statement that would
       * delete the whole table.
       */
      filters: { column: string; value: any; op?: string }[];
    }[];
    /**
     * Result-SHAPING calls (`.order()` / `.range()`), per table (ENG-993).
     *
     * These are not filters — they cannot make a mutation conditional — so
     * they must not land in `mutations[].filters`. They are recorded here
     * instead of being dropped, so that no method which *filters or shapes a
     * result* discards its arguments, and so a paging/sort assertion has
     * something to read.
     *
     * `args` has fixed arity: `.order("created_at")` records
     * `["created_at", undefined]`, not `["created_at"]`.
     *
     * Scope note — this is NOT a claim that the fake records everything.
     * `select()` still drops its column list (and `{ count, head }`), `or()`
     * keeps only the expression, and `insert`/`update`/`delete` ignore their
     * options argument. Those are unused by the assertions this fake supports;
     * add recording when a test actually needs to prove one.
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
  // Shared with the recorded mutation (same array reference), so `.eq()` calls
  // chained AFTER .delete()/.update() are still captured.
  //
  // ENG-993: re-seeded (copied) by `recordMutation` on every mutation, so that
  // two mutations off ONE `from()` builder don't share one array. They used to,
  // which meant a `.is(...)` guard belonging to the SECOND write also appeared
  // on the first — i.e. the aliasing could make a precondition assertion pass
  // for a write that never carried it. That false PASS is the exact failure
  // mode this ticket exists to remove, so it must not survive in the fix.
  let filters: { column: string; value: any; op?: string }[] = [];
  const script = () => state.tables[table] ?? {};
  // Snapshot the filters accumulated so far into a FRESH array, hand that to
  // the mutation record, and keep chaining into it — so filters chained after
  // the mutation still land on it, while an earlier mutation's record stays
  // frozen at what it actually carried.
  const recordMutation = (
    op: "insert" | "update" | "delete" | "upsert",
    payload: any,
    options?: any,
  ) => {
    filters = [...filters];
    const record: {
      table: string;
      op: "insert" | "update" | "delete" | "upsert";
      payload: any;
      options?: any;
      filters: { column: string; value: any; op?: string }[];
    } = { table, op, payload, filters };
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
