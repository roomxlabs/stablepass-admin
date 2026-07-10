import { describe, it, expect, beforeEach, vi } from "vitest";

// Drives the BFF sign-in/out server actions at the Supabase boundary and
// asserts the security-relevant branches: a valid but non-admin sign-in is
// torn back down, and sign-out clears the session.
type SessionUser = { id: string; email?: string } | null;

const state: {
  signInUser: SessionUser;
  signInError: boolean;
  profile: { is_admin: boolean } | null;
  signOutCalls: number;
} = { signInUser: null, signInError: false, profile: null, signOutCalls: 0 };

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => ({
    auth: {
      signInWithPassword: async () => ({
        data: { user: state.signInError ? null : state.signInUser },
        error: state.signInError ? { message: "invalid" } : null,
      }),
      signOut: async () => {
        state.signOutCalls += 1;
        return { error: null };
      },
    },
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: state.profile }) }) }),
    }),
  }),
}));

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

import { signIn, signOut } from "./actions";

function form(email?: string, password?: string): FormData {
  const fd = new FormData();
  if (email !== undefined) fd.set("email", email);
  if (password !== undefined) fd.set("password", password);
  return fd;
}

beforeEach(() => {
  state.signInUser = null;
  state.signInError = false;
  state.profile = null;
  state.signOutCalls = 0;
});

describe("signIn", () => {
  it("asks for both fields when either is missing", async () => {
    const r = await signIn({}, form("", ""));
    expect(r.error).toMatch(/email and password/i);
  });

  it("rejects wrong credentials without naming the bad field", async () => {
    state.signInError = true;
    const r = await signIn({}, form("x@stablepass.co", "nope"));
    expect(r.error).toBe("Wrong email or password.");
    expect(state.signOutCalls).toBe(0);
  });

  it("signs a valid NON-admin straight back out (no lingering session)", async () => {
    state.signInUser = { id: "u1", email: "member@stablepass.co" };
    state.profile = { is_admin: false };
    const r = await signIn({}, form("member@stablepass.co", "pw"));
    expect(r.error).toBe("That account isn't an admin.");
    expect(state.signOutCalls).toBe(1);
  });

  it("redirects an admin to the dashboard", async () => {
    state.signInUser = { id: "u1", email: "ops@stablepass.co" };
    state.profile = { is_admin: true };
    await expect(signIn({}, form("ops@stablepass.co", "pw"))).rejects.toThrow("REDIRECT:/");
    expect(state.signOutCalls).toBe(0);
  });
});

describe("signOut", () => {
  it("clears the session and returns to /signin", async () => {
    await expect(signOut()).rejects.toThrow("REDIRECT:/signin");
    expect(state.signOutCalls).toBe(1);
  });
});
