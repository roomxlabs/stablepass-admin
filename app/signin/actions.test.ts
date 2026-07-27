import { describe, it, expect, beforeEach, vi } from "vitest";

// Drives the BFF sign-in/out server actions at the Supabase boundary and
// asserts the security-relevant branches: a valid but non-admin sign-in is
// torn back down, sign-out clears the session, a password alone never reaches
// "/", and every attempt lands on the audit trail through the RIGHT RPC.
type SessionUser = { id: string; email?: string } | null;
type Factor = { id: string; factor_type: string; status: string };

const state: {
  signInUser: SessionUser;
  signInError: boolean;
  profile: { is_admin: boolean } | null;
  signOutCalls: number;
  totpFactors: Factor[];
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
  // Ordered log, so the audit-before-signOut ordering can be asserted.
  trace: string[];
} = {
  signInUser: null,
  signInError: false,
  profile: null,
  signOutCalls: 0,
  totpFactors: [],
  rpcCalls: [],
  trace: [],
};

vi.mock("next/headers", () => ({
  headers: async () => ({ get: () => null }),
}));

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => ({
    auth: {
      signInWithPassword: async () => ({
        data: { user: state.signInError ? null : state.signInUser },
        error: state.signInError ? { message: "invalid" } : null,
      }),
      signOut: async () => {
        state.signOutCalls += 1;
        state.trace.push("signOut");
        return { error: null };
      },
      mfa: {
        // auth-js puts only VERIFIED factors in the `totp` bucket.
        listFactors: async () => ({
          data: { all: state.totpFactors, totp: state.totpFactors, phone: [], webauthn: [] },
          error: null,
        }),
      },
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      state.trace.push(`rpc:${args.p_event ?? fn}`);
      return { data: null, error: null };
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

const VERIFIED_TOTP: Factor = { id: "f1", factor_type: "totp", status: "verified" };

beforeEach(() => {
  state.signInUser = null;
  state.signInError = false;
  state.profile = null;
  state.signOutCalls = 0;
  state.totpFactors = [];
  state.rpcCalls = [];
  state.trace = [];
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

  it("logs a failed password through the ANON RPC (log_admin_signin_fail)", async () => {
    // There is no session at this point, so log_admin_auth_event would write
    // zero rows and still return 204 — a silent loss of the key forensic event.
    state.signInError = true;
    await signIn({}, form("x@stablepass.co", "nope"));
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0]!.fn).toBe("log_admin_signin_fail");
    expect(state.rpcCalls[0]!.args.p_email).toBe("x@stablepass.co");
  });

  it("signs a valid NON-admin straight back out (no lingering session)", async () => {
    state.signInUser = { id: "u1", email: "member@stablepass.co" };
    state.profile = { is_admin: false };
    const r = await signIn({}, form("member@stablepass.co", "pw"));
    expect(r.error).toBe("That account isn't an admin.");
    expect(state.signOutCalls).toBe(1);
  });

  it("audits a VALID password on a non-admin account, before signing it out", async () => {
    // Working credentials aimed at the admin console is a forensic signal. A
    // session exists here, so it goes through the authenticated RPC — and, like
    // mfa_fail, it must be written before signOut() or the row is dropped.
    state.signInUser = { id: "u1", email: "member@stablepass.co" };
    state.profile = { is_admin: false };
    await signIn({}, form("member@stablepass.co", "pw"));
    expect(state.trace).toEqual(["rpc:signin_fail", "signOut"]);
    expect(state.rpcCalls[0]!.fn).toBe("log_admin_auth_event");
  });

  it("sends an admin WITH a verified factor to the code step, logging signin_ok", async () => {
    state.signInUser = { id: "u1", email: "ops@stablepass.co" };
    state.profile = { is_admin: true };
    state.totpFactors = [VERIFIED_TOTP];
    await expect(signIn({}, form("ops@stablepass.co", "pw"))).rejects.toThrow(
      "REDIRECT:/signin/mfa",
    );
    expect(state.signOutCalls).toBe(0);
    expect(state.rpcCalls[0]!.fn).toBe("log_admin_auth_event");
    expect(state.rpcCalls[0]!.args.p_event).toBe("signin_ok");
  });

  it("sends an admin with NO factor to forced enrolment", async () => {
    state.signInUser = { id: "u1", email: "ops@stablepass.co" };
    state.profile = { is_admin: true };
    state.totpFactors = [];
    await expect(signIn({}, form("ops@stablepass.co", "pw"))).rejects.toThrow(
      "REDIRECT:/signin/mfa-setup",
    );
  });

  it("never reaches the dashboard on a password alone", async () => {
    state.signInUser = { id: "u1", email: "ops@stablepass.co" };
    state.profile = { is_admin: true };
    state.totpFactors = [VERIFIED_TOTP];
    // Exact match, not substring: "REDIRECT:/signin/mfa" *contains* "REDIRECT:/".
    await expect(signIn({}, form("ops@stablepass.co", "pw"))).rejects.toSatisfy(
      (e: Error) => e.message !== "REDIRECT:/",
    );
  });
});

describe("signOut", () => {
  it("clears the session and returns to /signin", async () => {
    await expect(signOut()).rejects.toThrow("REDIRECT:/signin");
    expect(state.signOutCalls).toBe(1);
  });
});
