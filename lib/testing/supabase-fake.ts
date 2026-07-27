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
  calls: { functions: { name: string; body: any }[]; or: string[]; from: string[]; rpc: { name: string; args: any }[] };
};

type Builder = {
  select: (...a: any[]) => Builder;
  insert: (...a: any[]) => Builder;
  update: (...a: any[]) => Builder;
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
  const script = () => state.tables[table] ?? {};
  const pick = (): ScriptResult => (op === "mutate" ? script().mutate : script().select) ?? {};
  const b: Builder = {
    select: () => b,
    insert: () => { op = "mutate"; return b; },
    update: () => { op = "mutate"; return b; },
    delete: () => { op = "mutate"; return b; },
    eq: () => b,
    neq: () => b,
    is: () => b,
    in: () => b,
    ilike: () => b,
    or: (expr: string) => { state.calls.or.push(expr); return b; },
    order: () => b,
    range: () => b,
    gt: () => b,
    gte: () => b,
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
        createSignedUploadUrl: async (path: string) =>
          state.storage.signed ?? {
            data: { signedUrl: `https://storage.local/${bucket}/${path}`, token: "tok", path },
            error: null,
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
    calls: { functions: [], or: [], from: [], rpc: [] },
  };
}
