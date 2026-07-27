import { describe, it, expect, beforeEach, vi } from "vitest";

// Step 2 of sign-in. The security-relevant properties: a bad code drops the
// half-authenticated AAL1 session, the failure is logged BEFORE that sign-out
// (log_admin_auth_event is authenticated-only and no-ops silently once anon),
// and the user is bounced back to /signin with a generic message.
type Factor = { id: string; factor_type: string; status: string };

const state: {
  user: { id: string; email?: string } | null;
  totpFactors: Factor[];
  verifyFails: boolean;
  signOutCalls: number;
  // Ordered log of everything that hit the client, so we can assert SEQUENCE.
  trace: string[];
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
} = {
  user: null,
  totpFactors: [],
  verifyFails: false,
  signOutCalls: 0,
  trace: [],
  rpcCalls: [],
};

vi.mock("next/headers", () => ({
  headers: async () => ({ get: () => null }),
}));

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => ({
    auth: {
      getUser: async () => ({ data: { user: state.user } }),
      signOut: async () => {
        state.signOutCalls += 1;
        state.trace.push("signOut");
        return { error: null };
      },
      mfa: {
        listFactors: async () => ({
          data: { all: state.totpFactors, totp: state.totpFactors, phone: [], webauthn: [] },
          error: null,
        }),
        challengeAndVerify: async () => ({
          data: state.verifyFails ? null : { access_token: "t" },
          error: state.verifyFails ? { message: "Invalid TOTP code entered" } : null,
        }),
      },
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      state.trace.push(`rpc:${args.p_event ?? fn}`);
      return { data: null, error: null };
    },
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

import { verifyMfa } from "./actions";

function form(code: string): FormData {
  const fd = new FormData();
  fd.set("code", code);
  return fd;
}

const VERIFIED_TOTP: Factor = { id: "f1", factor_type: "totp", status: "verified" };

beforeEach(() => {
  state.user = { id: "u1", email: "ops@stablepass.co" };
  state.totpFactors = [VERIFIED_TOTP];
  state.verifyFails = false;
  state.signOutCalls = 0;
  state.trace = [];
  state.rpcCalls = [];
});

describe("verifyMfa — input", () => {
  it("rejects a non-6-digit code without calling Supabase", async () => {
    const r = await verifyMfa({}, form("12ab"));
    expect(r.error).toMatch(/6-digit/i);
    expect(state.trace).toEqual([]);
  });
});

describe("verifyMfa — session preconditions", () => {
  it("sends a code submitted with no session back to /signin", async () => {
    state.user = null;
    await expect(verifyMfa({}, form("123456"))).rejects.toThrow("REDIRECT:/signin");
  });

  it("sends a session with no enrolled factor to forced enrolment", async () => {
    state.totpFactors = [];
    await expect(verifyMfa({}, form("123456"))).rejects.toThrow("REDIRECT:/signin/mfa-setup");
  });
});

describe("verifyMfa — wrong code", () => {
  it("keeps the session and lets the admin retry in place", async () => {
    // A mistyped digit must cost a retry, not the whole sign-in: no signOut,
    // no redirect, just an error rendered back onto /signin/mfa.
    state.verifyFails = true;
    const res = await verifyMfa({}, form("000000"));
    expect(state.signOutCalls).toBe(0);
    expect(res.attempts).toBe(1);
    expect(res.error).toMatch(/didn't match/i);
    expect(state.rpcCalls.map((c) => c.args.p_event)).toContain("mfa_fail");
  });

  it("logs mfa_fail on EVERY miss, not only the last one", async () => {
    state.verifyFails = true;
    const first = await verifyMfa({}, form("000000"));
    const second = await verifyMfa(first, form("000000"));
    expect(second.attempts).toBe(2);
    expect(state.rpcCalls.filter((c) => c.args.p_event === "mfa_fail")).toHaveLength(2);
  });

  it("counts down the attempts left, singular on the last one", async () => {
    state.verifyFails = true;
    expect((await verifyMfa({ attempts: 3 }, form("000000"))).error).toContain("1 attempt left");
    expect((await verifyMfa({ attempts: 2 }, form("000000"))).error).toContain("2 attempts left");
  });

  it("signs out and returns to /signin generically once the attempts run out", async () => {
    state.verifyFails = true;
    await expect(verifyMfa({ attempts: 4 }, form("000000"))).rejects.toThrow(
      "REDIRECT:/signin?error=mfa",
    );
    expect(state.signOutCalls).toBe(1);
  });

  it("logs mfa_fail BEFORE signOut — after it, the RPC silently writes nothing", async () => {
    // This ordering is the whole reason the row survives: once signOut() lands
    // we are anon, and log_admin_auth_event's in-body guard drops the insert
    // while still returning 204.
    state.verifyFails = true;
    await expect(verifyMfa({ attempts: 4 }, form("000000"))).rejects.toThrow(
      "REDIRECT:/signin?error=mfa",
    );
    expect(state.trace).toEqual(["rpc:mfa_fail", "signOut"]);
  });

  it("does not burn an attempt on a malformed code — it never reaches verify", async () => {
    state.verifyFails = true;
    const res = await verifyMfa({ attempts: 2 }, form("12"));
    expect(res.attempts).toBe(2);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("uses the authenticated RPC, not the anon signin_fail one", async () => {
    state.verifyFails = true;
    await verifyMfa({}, form("000000"));
    expect(state.rpcCalls[0]!.fn).toBe("log_admin_auth_event");
  });
});

describe("verifyMfa — correct code", () => {
  it("logs mfa_ok and lands on the dashboard, keeping the session", async () => {
    await expect(verifyMfa({}, form("123456"))).rejects.toThrow("REDIRECT:/");
    expect(state.signOutCalls).toBe(0);
    expect(state.rpcCalls.map((c) => c.args.p_event)).toContain("mfa_ok");
  });
});
