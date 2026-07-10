import { describe, it, expect, beforeEach, vi } from "vitest";

// --- Test doubles ------------------------------------------------------
// The gate calls supabaseServer().auth.getUser() then reads app_user.is_admin.
// We drive both from `state` and assert the branch each gate takes.
type Profile = { is_admin: boolean } | null;
type SessionUser = { id: string; email?: string } | null;

const state: { user: SessionUser; profile: Profile } = { user: null, profile: null };

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => ({
    auth: {
      getUser: async () => ({ data: { user: state.user } }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: state.profile }),
        }),
      }),
    }),
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

beforeEach(() => {
  state.user = null;
  state.profile = null;
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

  it("passes (returns the client) for an admin", async () => {
    state.user = { id: "u1" };
    state.profile = { is_admin: true };
    const r = await requireAdmin();
    expect("sb" in r).toBe(true);
  });
});

describe("requireAdminPage — (dash) layout gate", () => {
  it("redirects to /signin when there is no session", async () => {
    await expect(requireAdminPage()).rejects.toThrow("REDIRECT:/signin");
  });

  it("redirects to /signin?error=forbidden for a non-admin (the 403 branch)", async () => {
    state.user = { id: "u1" };
    state.profile = { is_admin: false };
    await expect(requireAdminPage()).rejects.toThrow("REDIRECT:/signin?error=forbidden");
  });

  it("redirects (fails closed) when the user has no app_user row", async () => {
    state.user = { id: "u1" };
    state.profile = null;
    await expect(requireAdminPage()).rejects.toThrow("REDIRECT:/signin?error=forbidden");
  });

  it("passes for an admin, exposing the signed-in user (renders → 200)", async () => {
    state.user = { id: "u1", email: "ops@stablepass.co" };
    state.profile = { is_admin: true };
    const r = await requireAdminPage();
    expect(r.user.email).toBe("ops@stablepass.co");
  });
});
