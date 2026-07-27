import { describe, it, expect, beforeEach, vi } from "vitest";

// --- Test doubles ------------------------------------------------------
// The gate calls supabaseServer().auth.getUser(), reads app_user.is_admin, then
// reads the assurance level. We drive all three from `state` and assert the
// branch each gate takes — plus, for the guardrail, that no table read happens
// beyond the gate's own app_user lookup before it bails out.
type Profile = { is_admin: boolean } | null;
type SessionUser = { id: string; email?: string } | null;
type Aal = { currentLevel: string | null; nextLevel: string | null };

const state: {
  user: SessionUser;
  profile: Profile;
  aal: Aal;
  aalThrows: boolean;
  aalError: boolean;
  fromCalls: string[];
} = {
  user: null,
  profile: null,
  aal: { currentLevel: "aal2", nextLevel: "aal2" },
  aalThrows: false,
  aalError: false,
  fromCalls: [],
};

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => ({
    auth: {
      getUser: async () => ({ data: { user: state.user } }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => {
          if (state.aalThrows) throw new Error("network");
          // auth-js returns {data:null, error} on a session error rather than
          // throwing — the COMMON failure path, so it must be expressible here.
          if (state.aalError) return { data: null, error: { message: "session error" } };
          return { data: state.aal, error: null };
        },
      },
    },
    from: (table: string) => {
      state.fromCalls.push(table);
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: state.profile }),
          }),
        }),
      };
    },
  }),
}));

// redirect() normally throws NEXT_REDIRECT; we throw a tagged error so tests
// can assert the destination.
class RedirectError extends Error {
  constructor(public url: string) {
    super(`REDIRECT:${url}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectError(url);
  },
}));

import { requireAdmin, requireAdminPage } from "./admin";

const AAL1 = { currentLevel: "aal1", nextLevel: "aal2" };           // enrolled, not challenged
const AAL1_NO_FACTOR = { currentLevel: "aal1", nextLevel: "aal1" }; // nothing enrolled
const AAL2 = { currentLevel: "aal2", nextLevel: "aal2" };

beforeEach(() => {
  state.user = null;
  state.profile = null;
  state.aal = AAL2;
  state.aalThrows = false;
  state.aalError = false;
  state.fromCalls = [];
});

describe("requireAdmin — API route gate", () => {
  it("401s when there is no session", async () => {
    const r = await requireAdmin();
    expect("res" in r).toBe(true);
    if ("res" in r) expect(r.res.status).toBe(401);
  });

  it("403s for a signed-in non-admin", async () => {
    state.user = { id: "u1" };
    state.profile = { is_admin: false };
    const r = await requireAdmin();
    expect("res" in r).toBe(true);
    if ("res" in r) expect(r.res.status).toBe(403);
  });

  it("403s (fails closed) when the user has no app_user row", async () => {
    state.user = { id: "u1" };
    state.profile = null;
    const r = await requireAdmin();
    expect("res" in r).toBe(true);
    if ("res" in r) expect(r.res.status).toBe(403);
  });

  it("passes (returns the client) for an admin at aal2", async () => {
    state.user = { id: "u1" };
    state.profile = { is_admin: true };
    state.aal = AAL2;
    const r = await requireAdmin();
    expect("sb" in r).toBe(true);
  });

  // --- ENG-370 guardrail: aal2 is an ADDITIONAL condition ----------------
  it("403s an ADMIN whose session is only aal1 — never 200, never 401", async () => {
    state.user = { id: "u1" };
    state.profile = { is_admin: true };
    state.aal = AAL1;
    const r = await requireAdmin();
    expect("res" in r).toBe(true);
    if ("res" in r) {
      expect(r.res.status).toBe(403);
      const body = await r.res.json();
      expect(body.error.code).toBe("mfa_required");
    }
  });

  it("fails CLOSED (403) when the assurance level can't be read", async () => {
    state.user = { id: "u1" };
    state.profile = { is_admin: true };
    state.aalThrows = true;
    const r = await requireAdmin();
    expect("res" in r).toBe(true);
    if ("res" in r) expect(r.res.status).toBe(403);
  });
});

describe("requireAdminPage — (dash) layout gate", () => {
  it("redirects to /signin when there is no session", async () => {
    await expect(requireAdminPage()).rejects.toThrow("REDIRECT:/signin");
    // Bails before touching a single table.
    expect(state.fromCalls).toEqual([]);
  });

  it("redirects to /signin?error=forbidden for a non-admin (the 403 branch)", async () => {
    state.user = { id: "u1" };
    state.profile = { is_admin: false };
    await expect(requireAdminPage()).rejects.toThrow("REDIRECT:/signin?error=forbidden");
    expect(state.fromCalls).toEqual(["app_user"]);
  });

  it("redirects (fails closed) when the user has no app_user row", async () => {
    state.user = { id: "u1" };
    state.profile = null;
    await expect(requireAdminPage()).rejects.toThrow("REDIRECT:/signin?error=forbidden");
  });

  it("passes for an admin at aal2, exposing the signed-in user (renders → 200)", async () => {
    state.user = { id: "u1", email: "ops@stablepass.co" };
    state.profile = { is_admin: true };
    state.aal = AAL2;
    const r = await requireAdminPage();
    expect(r.user.email).toBe("ops@stablepass.co");
  });

  // --- ENG-370 guardrail -------------------------------------------------
  it("redirects an aal1 admin WITH a factor to /signin/mfa, before any page read", async () => {
    state.user = { id: "u1" };
    state.profile = { is_admin: true };
    state.aal = AAL1;
    await expect(requireAdminPage()).rejects.toThrow("REDIRECT:/signin/mfa");
    // Only the gate's own is_admin lookup ran — the caller never got `sb`, so
    // no (dash) page read could hit the 0-rows-no-error aal2 RLS behaviour.
    expect(state.fromCalls).toEqual(["app_user"]);
  });

  it("redirects an aal1 admin with NO factor to /signin/mfa-setup", async () => {
    state.user = { id: "u1" };
    state.profile = { is_admin: true };
    state.aal = AAL1_NO_FACTOR;
    await expect(requireAdminPage()).rejects.toThrow("REDIRECT:/signin/mfa-setup");
  });

  it("fails CLOSED when the assurance read THROWS — and to the challenge, not enrolment", async () => {
    state.user = { id: "u1" };
    state.profile = { is_admin: true };
    state.aalThrows = true;
    // "Unreadable" must not be mistaken for "nothing enrolled": an enrolled
    // admin would otherwise be pushed into forced re-enrolment on a blip.
    await expect(requireAdminPage()).rejects.toThrow("REDIRECT:/signin/mfa");
    expect(state.fromCalls).toEqual(["app_user"]);
  });

  it("fails CLOSED on the {data:null,error} shape — auth-js's COMMON failure path", async () => {
    state.user = { id: "u1" };
    state.profile = { is_admin: true };
    state.aalError = true;
    await expect(requireAdminPage()).rejects.toThrow("REDIRECT:/signin/mfa");
  });
});

// These two shapes are the ones a naive implementation lets through, because
// neither is an exception and neither equals the string "aal1".
describe("guardrail — fail-open shapes that must still be denied", () => {
  beforeEach(() => {
    state.user = { id: "u1" };
    state.profile = { is_admin: true };
  });

  it("denies a {data:null,error} assurance read on the API gate", async () => {
    state.aalError = true;
    const r = await requireAdmin();
    expect("res" in r).toBe(true);
    if ("res" in r) {
      expect(r.res.status).toBe(403);
      expect((await r.res.json()).error.code).toBe("mfa_required");
    }
  });

  it("denies currentLevel:null (no aal claim at all) rather than treating it as pass", async () => {
    state.aal = { currentLevel: null, nextLevel: null };
    const r = await requireAdmin();
    expect("res" in r).toBe(true);
    if ("res" in r) expect(r.res.status).toBe(403);
    await expect(requireAdminPage()).rejects.toThrow("REDIRECT:/signin/mfa-setup");
  });
});
