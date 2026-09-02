import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * `requireAdminPage()` is called TWICE per navigation on purpose: the `(dash)`
 * layout gates the shell, and every data-bearing page re-asserts the gate for
 * itself, because Next renders layout and page in parallel and caches the
 * layout across soft navigations (see .rx/gotchas.md). Both call sites stay.
 *
 * What must NOT happen twice is the WORK: `auth.getUser()`, the `app_user`
 * read, and the assurance-level lookup. React's `cache()` makes the second call
 * reuse the first result for the life of one request. This file is the proof.
 *
 * WHY `cache` IS MOCKED HERE. React ships two builds. Only the `react-server`
 * one has a memoising `cache()`; the client build vitest resolves is a
 * pass-through, and there is no request scope in a unit test to memoise into —
 * so against the REAL import this test could not distinguish a cached gate from
 * an uncached one (it counts 2 either way, whatever the source says). The mock
 * supplies the per-scope memo that a request would, so the assertion below
 * fails for exactly one reason: `requireAdminPage` stopped going through
 * `cache()`. That is the regression worth catching.
 */
/**
 * The current "request". React's cache is scoped to one request, so the stand-in
 * has to be too — otherwise the memo would leak across tests and the second
 * test would read the first one's answer, which is not what production does.
 * `beforeEach` starts a new request by bumping this.
 */
const scope = { id: 0 };

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    // A faithful stand-in for the server build: one memo per wrapped function
    // PER REQUEST, keyed by the serialised arguments (the gate takes none).
    cache: <A extends unknown[], R>(fn: (...args: A) => R) => {
      const memo = new Map<string, R>();
      return (...args: A): R => {
        const key = `${scope.id}:${JSON.stringify(args)}`;
        if (!memo.has(key)) memo.set(key, fn(...args));
        return memo.get(key) as R;
      };
    },
  };
});

const state = {
  user: null as { id: string } | null,
  profile: null as { is_admin: boolean } | null,
  aal: { currentLevel: "aal2", nextLevel: "aal2" },
  getUserCalls: 0,
  aalCalls: 0,
  fromCalls: [] as string[],
};

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => ({
    auth: {
      getUser: async () => {
        state.getUserCalls += 1;
        return { data: { user: state.user } };
      },
      mfa: {
        getAuthenticatorAssuranceLevel: async () => {
          state.aalCalls += 1;
          return { data: state.aal, error: null };
        },
      },
    },
    from: (table: string) => {
      state.fromCalls.push(table);
      return { select: () => ({ eq: () => ({ single: async () => ({ data: state.profile }) }) }) };
    },
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

import { requireAdminPage } from "./admin";

beforeEach(() => {
  scope.id += 1; // a new request
  state.user = { id: "u1" };
  state.profile = { is_admin: true };
  state.aal = { currentLevel: "aal2", nextLevel: "aal2" };
  state.getUserCalls = 0;
  state.aalCalls = 0;
  state.fromCalls = [];
});

describe("requireAdminPage — one round-trip set per request", () => {
  it("does the auth + app_user + AAL work ONCE across the layout's call and the page's", async () => {
    // The layout gates the shell…
    const fromLayout = await requireAdminPage();
    // …and the page re-asserts, deliberately, rather than trusting it.
    const fromPage = await requireAdminPage();

    expect(state.getUserCalls).toBe(1);
    expect(state.fromCalls).toEqual(["app_user"]); // one is_admin read, not two
    expect(state.aalCalls).toBe(1);

    // Both callers still get a usable gate result — memoised, not skipped.
    expect(fromPage.user).toEqual(fromLayout.user);
    expect(fromPage.sb).toBe(fromLayout.sb);
  });

  it("still gates: a non-admin redirects from BOTH call sites", async () => {
    state.profile = { is_admin: false };

    await expect(requireAdminPage()).rejects.toThrow("REDIRECT:/signin?error=forbidden");
    // The memoised rejection redirects identically — a cached gate can never
    // decay into a pass on the second call.
    await expect(requireAdminPage()).rejects.toThrow("REDIRECT:/signin?error=forbidden");
    expect(state.getUserCalls).toBe(1);
  });

  it("still gates an aal1 admin, before any page read", async () => {
    state.aal = { currentLevel: "aal1", nextLevel: "aal2" };

    await expect(requireAdminPage()).rejects.toThrow("REDIRECT:/signin/mfa");
    await expect(requireAdminPage()).rejects.toThrow("REDIRECT:/signin/mfa");
    // Only the gate's own is_admin lookup ran — the caller never got `sb`.
    expect(state.fromCalls).toEqual(["app_user"]);
  });
});
