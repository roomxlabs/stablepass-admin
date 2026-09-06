/* eslint-disable @typescript-eslint/no-explicit-any */
// Test-support only: a scriptable stand-in for the Supabase server client so
// `app/api/admin/posts/*` route handlers can be unit-tested without a live
// backend. Tests `vi.mock("@/lib/supabase/server")` to return `makeFakeClient(state)`
// and drive results per table via `state.tables`. Not imported by app code.

export type ScriptResult = { single?: any; rows?: any[]; count?: number; error?: any };

export type TableScript = {
  // Result for a read chain (`.select(...).eq(...).single()` / awaited list).
  select?: ScriptResult;
  /**
   * Results for CONSECUTIVE reads of the same table, consumed one per chain in
   * the order the code issues them; `select` is the fallback once the queue is
   * empty.
   *
   * A single `select` cannot express a screen that now asks the same table
   * several different questions — four `{ count: "exact", head: true }` counts
   * over `horse`, or one count per subscription status — because every chain
   * would answer with the same number and a test could not tell a correct
   * implementation from one that ran the same query four times.
   */
  selectQueue?: ScriptResult[];
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
  limit: (...a: any[]) => Builder;
  range: (...a: any[]) => Builder;
  not: (...a: any[]) => Builder;
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
  const filters: { column: string; value: any; op?: string }[] = [];
  const script = () => state.tables[table] ?? {};
  // Resolved ONCE per chain (and memoised), so `.single()` and `then` on the
  // same builder cannot consume two entries of the queue.
  let resolved: ScriptResult | undefined;
  const pick = (): ScriptResult => {
    if (resolved) return resolved;
    if (op === "mutate") return (resolved = script().mutate ?? {});
    const queue = script().selectQueue;
    resolved = (queue && queue.length ? queue.shift() : script().select) ?? {};
    return resolved;
  };
  const b: Builder = {
    select: () => b,
    insert: (payload?: any) => {
      op = "mutate";
      state.calls.mutations.push({ table, op: "insert", payload, filters });
      return b;
    },
    update: (payload?: any) => {
      op = "mutate";
      state.calls.mutations.push({ table, op: "update", payload, filters });
      return b;
    },
    // Mirrors `insert` exactly (same op-flip, same script table), but records
    // `op: "upsert"` and the options arg — the arbiter is the whole point of
    // calling this instead of `.insert()` (ENG-748), so it has to be provable.
    upsert: (payload?: any, options?: any) => {
      op = "mutate";
      state.calls.mutations.push({ table, op: "upsert", payload, options, filters });
      return b;
    },
    delete: () => {
      op = "mutate";
      state.calls.mutations.push({ table, op: "delete", payload: undefined, filters });
      return b;
    },
    eq: (column?: any, value?: any) => {
      filters.push({ column, value });
      return b;
    },
    neq: () => b,
    is: () => b,
    in: () => b,
    ilike: () => b,
    or: (expr: string) => { state.calls.or.push(expr); return b; },
    order: () => b,
    // ENG query-batch: embedded order/limit (`.limit(1, { referencedTable })`)
    // is how a "latest child row per parent" read is expressed in PostgREST, so
    // the builder has to ACCEPT it — the call-recorder is what asserts the
    // arguments. A missing method here would throw before a test could look.
    limit: () => b,
    range: () => b,
    not: () => b,
    gt: () => b,
    // Records its filter (unlike the other range comparators, which stay
    // no-ops) because ENG-748's trailing-set trim is a `.delete().eq(post_id)
    // .gte(sort_order, n)` — without this a test asserting "the tail was
    // trimmed from the right ordinal" has nothing to read the `n` off, and a
    // trim that dropped the whole set (gte 0) would look identical to a
    // correct one.
    gte: (column?: any, value?: any) => {
      filters.push({ column, value, op: "gte" });
      return b;
    },
    lt: () => b,
    lte: () => b,
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
    calls: { functions: [], or: [], from: [], rpc: [], mutations: [], storage: [] },
  };
}
