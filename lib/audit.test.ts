import { describe, it, expect, beforeEach, vi } from "vitest";

// The audit wrapper's whole job is to be UNABLE to break sign-in, and to pick
// the right one of stablepass-be's two RPCs. Both are asserted here.
const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const state: { throwOnRpc: boolean; headers: Record<string, string>; headersThrow: boolean } = {
  throwOnRpc: false,
  headers: {},
  headersThrow: false,
};

vi.mock("next/headers", () => ({
  headers: async () => {
    if (state.headersThrow) throw new Error("headers() unavailable");
    return { get: (k: string) => state.headers[k.toLowerCase()] ?? null };
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => fakeClient(),
}));

function fakeClient() {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (state.throwOnRpc) throw new Error("PostgREST is down");
      return { data: null, error: null };
    },
  };
}

import { logAdminAuthEvent, logAdminSignInFail, parseIp } from "./audit";

beforeEach(() => {
  calls.length = 0;
  state.throwOnRpc = false;
  state.headers = {};
  state.headersThrow = false;
});

describe("parseIp — p_ip is typed `inet`, a bad cast raises 22P02", () => {
  it("takes the first hop of a comma-separated X-Forwarded-For chain", () => {
    // Passing this raw is the bug: "1.2.3.4, 5.6.7.8" is not a valid inet.
    expect(parseIp("1.2.3.4, 5.6.7.8, 9.10.11.12")).toBe("1.2.3.4");
  });

  it("accepts a plain IPv4 and IPv6 address", () => {
    expect(parseIp("203.0.113.7")).toBe("203.0.113.7");
    expect(parseIp("2001:db8::1")).toBe("2001:db8::1");
    expect(parseIp("::1")).toBe("::1");
  });

  it("strips a port and IPv6 brackets", () => {
    expect(parseIp("1.2.3.4:5678")).toBe("1.2.3.4");
    expect(parseIp("[2001:db8::1]:443")).toBe("2001:db8::1");
  });

  it("accepts an IPv4-mapped IPv6 address (the routine dual-stack form)", () => {
    expect(parseIp("::ffff:192.0.2.1")).toBe("::ffff:192.0.2.1");
    expect(parseIp("1:2:3:4:5:6:1.2.3.4")).toBe("1:2:3:4:5:6:1.2.3.4");
    expect(parseIp("1:2:3:4:5:6:7:8")).toBe("1:2:3:4:5:6:7:8");
    expect(parseIp("::")).toBe("::");
  });

  it("returns null for anything Postgres would reject", () => {
    expect(parseIp(null)).toBeNull();
    expect(parseIp("")).toBeNull();
    expect(parseIp("unknown")).toBeNull();
    expect(parseIp("999.1.1.1")).toBeNull();
    expect(parseIp("proxy.internal")).toBeNull();
    expect(parseIp("1.2.3.4/24")).toBeNull();
  });

  // Regression: these all LOOK like IPv6 and all raise 22P02 from the argument
  // cast, which would silently discard the audit row. An earlier version of
  // parseIp only bounded the group COUNT (<=8) and let every one of these
  // through — meaning an attacker could suppress their own signin_fail rows
  // with a single `X-Forwarded-For: :::` header. Verified rejected by Postgres.
  it("rejects PARTIAL / malformed IPv6 that would raise 22P02", () => {
    for (const bad of [
      ":", "::: ".trim(), "1:2", "1:2:3", "abcd:", ":abcd", "0:0",
      "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:", ":1:2:3:4:5:6:7:8",
      "1::2::3", "12345::1", "fe80::1%eth0", "::ffff:999.1.1.1",
    ]) {
      expect(parseIp(bad), `expected ${bad} to be rejected`).toBeNull();
    }
  });

  it("still falls through to x-real-ip when the XFF value is junk", () => {
    // parseIp returning null is what makes the `??` fallback in requestMeta work.
    expect(parseIp("1:2")).toBeNull();
  });
});

describe("logAdminSignInFail — the anon-callable RPC", () => {
  it("calls log_admin_signin_fail, NOT log_admin_auth_event", async () => {
    // A failed password has no session; the general RPC's in-body guard would
    // write zero rows and still succeed, silently losing the event.
    await logAdminSignInFail("ops@stablepass.co", fakeClient());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe("log_admin_signin_fail");
    expect(calls[0]!.args.p_email).toBe("ops@stablepass.co");
    expect(calls[0]!.args).not.toHaveProperty("p_event");
  });

  it("forwards a single parsed IP, never the raw XFF list", async () => {
    state.headers = { "x-forwarded-for": "198.51.100.9, 10.0.0.1", "user-agent": "Chrome/1" };
    await logAdminSignInFail("ops@stablepass.co", fakeClient());
    expect(calls[0]!.args.p_ip).toBe("198.51.100.9");
    expect(calls[0]!.args.p_user_agent).toBe("Chrome/1");
  });
});

describe("logAdminAuthEvent — the authenticated RPC", () => {
  it("calls log_admin_auth_event with the event as a parameter", async () => {
    await logAdminAuthEvent("signin_ok", "ops@stablepass.co", fakeClient());
    expect(calls[0]!.fn).toBe("log_admin_auth_event");
    expect(calls[0]!.args.p_event).toBe("signin_ok");
  });

  it("caps the user-agent at the RPC's own 512-char limit", async () => {
    state.headers = { "user-agent": "x".repeat(9000) };
    await logAdminAuthEvent("mfa_ok", "ops@stablepass.co", fakeClient());
    expect(String(calls[0]!.args.p_user_agent)).toHaveLength(512);
  });
});

describe("guardrail — a logging failure never breaks sign-in", () => {
  it("swallows an RPC that throws", async () => {
    state.throwOnRpc = true;
    await expect(logAdminAuthEvent("signin_ok", "ops@stablepass.co", fakeClient())).resolves
      .toBeUndefined();
    await expect(logAdminSignInFail("ops@stablepass.co", fakeClient())).resolves.toBeUndefined();
  });

  it("swallows headers() being unavailable", async () => {
    state.headersThrow = true;
    await expect(logAdminAuthEvent("mfa_fail", "ops@stablepass.co", fakeClient())).resolves
      .toBeUndefined();
    expect(calls[0]!.args.p_ip).toBeNull();
    expect(calls[0]!.args.p_user_agent).toBeNull();
  });

  it("falls back to supabaseServer() when no client is handed in", async () => {
    await expect(logAdminAuthEvent("signin_ok", "ops@stablepass.co")).resolves.toBeUndefined();
    expect(calls[0]!.fn).toBe("log_admin_auth_event");
  });

  it("SURFACES a resolved {error} instead of swallowing it blind", async () => {
    // postgrest-js resolves with {data,error}; it does not reject. Without this
    // check a bad inet cast, a renamed RPC and a revoked grant would all be
    // indistinguishable from success, and the audit trail could be dead forever
    // without anyone noticing.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const erroring = {
      rpc: async () => ({ error: { code: "22P02", message: "invalid input syntax for inet" } }),
    };
    await expect(logAdminSignInFail("ops@stablepass.co", erroring)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0])).toContain("22P02");
    warn.mockRestore();
  });
});
