import { describe, it, expect, beforeEach, vi } from "vitest";

// Forced enrolment, step 2: verify the first code (ENG-371).
//
// The security-relevant properties this file pins:
//   * a WRONG code must NOT sign the admin out. There is no verified factor to
//     fall back to here, so a sign-out strands them in /signin -> gate ->
//     /signin/mfa-setup forever. `signOutCalls` is asserted to stay 0.
//   * success logs `mfa_enrolled` through the AUTHENTICATED RPC
//     (log_admin_auth_event), which is correct because a session already exists.
//   * a factor id the session does not own is refused before it is spent.
//
// Hand-rolled rather than `lib/testing/supabase-fake.ts` for the same reason
// A1's challenge-screen test is: that fake models from()/rpc()/storage but no
// `auth.mfa.*` and no signOut, so it cannot express any of the above. (It also
// defaults `aal` to "aal2" — see page.test.ts, where that matters.)
type Factor = { id: string; factor_type: string; status: string };

const state: {
  user: { id: string; email?: string } | null;
  factors: Factor[];
  listFails: boolean;
  verifyFails: boolean;
  signOutCalls: number;
  verifyArgs: Array<{ factorId: string; code: string }>;
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
} = {
  user: null,
  factors: [],
  listFails: false,
  verifyFails: false,
  signOutCalls: 0,
  verifyArgs: [],
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
        return { error: null };
      },
      mfa: {
        listFactors: async () =>
          state.listFails
            ? { data: null, error: { message: "network" } }
            : {
                data: {
                  all: state.factors,
                  totp: state.factors.filter((f) => f.status === "verified"),
                  phone: [],
                },
                error: null,
              },
        challengeAndVerify: async (args: { factorId: string; code: string }) => {
          state.verifyArgs.push(args);
          return {
            data: state.verifyFails ? null : { access_token: "t" },
            error: state.verifyFails ? { message: "Invalid TOTP code entered" } : null,
          };
        },
      },
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
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

import { verifyEnrolment } from "./actions";

function form(code: string, factorId = "factor-new"): FormData {
  const fd = new FormData();
  fd.set("code", code);
  fd.set("factorId", factorId);
  return fd;
}

const UNVERIFIED: Factor = { id: "factor-new", factor_type: "totp", status: "unverified" };

beforeEach(() => {
  state.user = { id: "u1", email: "ops@stablepass.co" };
  state.factors = [UNVERIFIED];
  state.listFails = false;
  state.verifyFails = false;
  state.signOutCalls = 0;
  state.verifyArgs = [];
  state.rpcCalls = [];
});

describe("verifyEnrolment — input", () => {
  it("rejects a non-6-digit code without calling Supabase", async () => {
    const r = await verifyEnrolment({}, form("12ab"));
    expect(r.error).toMatch(/6-digit/i);
    expect(state.verifyArgs).toEqual([]);
    expect(state.rpcCalls).toEqual([]);
  });

  it("rejects a submission with no factor id", async () => {
    const fd = new FormData();
    fd.set("code", "123456");
    const r = await verifyEnrolment({}, fd);
    expect(r.error).toMatch(/expired/i);
    expect(state.verifyArgs).toEqual([]);
  });
});

describe("verifyEnrolment — session preconditions", () => {
  it("sends a code submitted with no session back to /signin", async () => {
    state.user = null;
    await expect(verifyEnrolment({}, form("123456"))).rejects.toThrow("REDIRECT:/signin");
    expect(state.verifyArgs).toEqual([]);
  });

  it("refuses a factor id this session does not own, without spending it", async () => {
    const r = await verifyEnrolment({}, form("123456", "someone-elses-factor"));
    expect(r.error).toMatch(/expired/i);
    expect(state.verifyArgs).toEqual([]);
  });

  it("still verifies when the ownership read itself fails (no lock-out on a blip)", async () => {
    state.listFails = true;
    await expect(verifyEnrolment({}, form("123456"))).rejects.toThrow("REDIRECT:/");
    expect(state.verifyArgs).toHaveLength(1);
  });
});

describe("verifyEnrolment — wrong code", () => {
  it("returns an inline error and does NOT sign the admin out", async () => {
    // The whole point of this screen's failure branch: signing out here would
    // drop the only session that can finish enrolment, and the gate would send
    // them straight back — an unbreakable loop.
    state.verifyFails = true;
    const r = await verifyEnrolment({}, form("000000"));
    expect(r.error).toMatch(/didn't match/i);
    expect(state.signOutCalls).toBe(0);
  });

  it("leaves the admin on the screen to retry rather than redirecting away", async () => {
    // Returning (not throwing a redirect) is what keeps the QR, the factor and
    // the session in place for the next code from the authenticator app.
    state.verifyFails = true;
    const r = await verifyEnrolment({}, form("000000"));
    expect(r).toEqual({ error: expect.stringMatching(/didn't match/i) });
    // No audit row on a miss — see the PR body; the forensic signal for this
    // screen is the `mfa_enrolled` row written on success.
    expect(state.rpcCalls).toEqual([]);
  });
});

describe("verifyEnrolment — correct code", () => {
  it("verifies the factor whose QR was on screen", async () => {
    await expect(verifyEnrolment({}, form("123456"))).rejects.toThrow("REDIRECT:/");
    expect(state.verifyArgs).toEqual([{ factorId: "factor-new", code: "123456" }]);
  });

  it("logs mfa_enrolled via the authenticated RPC and lands on the dashboard", async () => {
    await expect(verifyEnrolment({}, form("123456"))).rejects.toThrow("REDIRECT:/");
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0]!.fn).toBe("log_admin_auth_event");
    expect(state.rpcCalls[0]!.args.p_event).toBe("mfa_enrolled");
  });

  it("keeps the session — no sign-out on the happy path either", async () => {
    await expect(verifyEnrolment({}, form("123456"))).rejects.toThrow("REDIRECT:/");
    expect(state.signOutCalls).toBe(0);
  });
});
