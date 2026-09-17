import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";
import { recordCalls, blankRecord, type CallRecord } from "@/lib/testing/call-recorder";

// The Supabase client is faked; the admin GATE is the real requireAdmin(), so
// the 403s below are the gate's own answers, not a mocked one.
const state: FakeState = blankState();
const rec: CallRecord = blankRecord();
vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => recordCalls(makeFakeClient(state), rec),
}));

import { DELETE, POST } from "./route";

const MEMBER = "3f2b8c1e-5a4d-4e7f-9b6a-2c1d0e9f8a7b";
const ctx = (id = MEMBER) => ({ params: Promise.resolve({ id }) });
const postReq = (body: unknown) =>
  new Request(`http://t/api/admin/subscribers/${MEMBER}/comp`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const delReq = () => new Request(`http://t/api/admin/subscribers/${MEMBER}/comp`, { method: "DELETE" });

let fetchMock: ReturnType<typeof vi.fn>;
let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

function asAdmin() {
  state.user = { id: "admin-1", email: "ops@stablepass.co" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}
function asNonAdmin() {
  state.user = { id: "member-1" };
  state.tables.app_user = { select: { single: { is_admin: false } } };
}
function asAal1Admin() {
  asAdmin();
  state.aal = "aal1";
}

// ADMIN NEVER WRITES `subscription` (epic decision 12). Asserted on every test:
// no mutation at all, and the only table this route may even name is the gate's.
function assertNoSubscriptionWrite() {
  expect(rec.writes).toEqual([]);
  expect(state.calls.mutations).toEqual([]);
  expect(state.calls.from.filter((t) => t !== "app_user")).toEqual([]);
}

beforeEach(() => {
  Object.assign(state, blankState());
  Object.assign(rec, blankRecord());
  vi.stubEnv("REVENUECAT_SECRET_API_KEY", "sk_test_secret");
  fetchMock = vi.fn(async () => new Response("{}", { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  assertNoSubscriptionWrite();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  info.mockRestore();
  warn.mockRestore();
});

describe("POST /api/admin/subscribers/:id/comp — grant", () => {
  it("401 without a session", async () => {
    const r = await POST(postReq({ duration: "monthly" }), ctx());
    expect(r.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("403 forbidden for a non-admin (guardrail 1)", async () => {
    asNonAdmin();
    const r = await POST(postReq({ duration: "monthly" }), ctx());
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("forbidden");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("403 mfa_required for an AAL1 admin", async () => {
    asAal1Admin();
    const r = await POST(postReq({ duration: "monthly" }), ctx());
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("mfa_required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["not-a-uuid", "------------------------------------", `${MEMBER}/../x`])(
    "400 invalid_id for %j, before RevenueCat is called",
    async (id) => {
      asAdmin();
      const r = await POST(postReq({ duration: "monthly" }), ctx(id));
      expect(r.status).toBe(400);
      expect((await r.json()).error.code).toBe("invalid_id");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([["lifetime"], ["daily"], [undefined], [3]])("400 invalid_duration for %j", async (duration) => {
    asAdmin();
    const r = await POST(postReq({ duration }), ctx());
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("invalid_duration");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("400 invalid_duration for an unparseable body", async () => {
    asAdmin();
    const r = await POST(postReq("{nope"), ctx());
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("invalid_duration");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("200 grant: calls RevenueCat for THIS member and logs ids only", async () => {
    asAdmin();
    const r = await POST(postReq({ duration: "three_month" }), ctx());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ data: { granted: true, duration: "three_month" } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.revenuecat.com/v1/subscribers/${MEMBER}/entitlements/content/promotional`,
    );

    expect(info).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(info.mock.calls[0][0]));
    expect(line).toEqual({
      event: "admin_comp_granted",
      adminUid: "admin-1",
      targetUid: MEMBER,
      duration: "three_month",
    });
    // No member/admin PII in the audit line.
    expect(String(info.mock.calls[0][0])).not.toMatch(/@/);
  });

  it("502 revenuecat_unavailable when RevenueCat answers non-2xx", async () => {
    asAdmin();
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    const r = await POST(postReq({ duration: "monthly" }), ctx());
    expect(r.status).toBe(502);
    expect((await r.json()).error.code).toBe("revenuecat_unavailable");
    expect(info).not.toHaveBeenCalled();
    // The failure is logged with ids, kind and upstream status — no body, no PII.
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toEqual({
      event: "admin_comp_failed",
      adminUid: "admin-1",
      targetUid: MEMBER,
      duration: "monthly",
      kind: "unavailable",
      status: 500,
    });
  });

  it("502 revenuecat_unavailable when fetch itself fails", async () => {
    asAdmin();
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const r = await POST(postReq({ duration: "monthly" }), ctx());
    expect(r.status).toBe(502);
    expect((await r.json()).error.code).toBe("revenuecat_unavailable");
  });

  it("503 revenuecat_not_configured without the env key", async () => {
    asAdmin();
    vi.stubEnv("REVENUECAT_SECRET_API_KEY", "");
    const r = await POST(postReq({ duration: "monthly" }), ctx());
    expect(r.status).toBe(503);
    expect((await r.json()).error.code).toBe("revenuecat_not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/admin/subscribers/:id/comp — revoke", () => {
  it("401 without a session", async () => {
    const r = await DELETE(delReq(), ctx());
    expect(r.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("403 forbidden for a non-admin (guardrail 1)", async () => {
    asNonAdmin();
    const r = await DELETE(delReq(), ctx());
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("forbidden");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("403 mfa_required for an AAL1 admin", async () => {
    asAal1Admin();
    const r = await DELETE(delReq(), ctx());
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("mfa_required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("400 invalid_id for a non-uuid", async () => {
    asAdmin();
    const r = await DELETE(delReq(), ctx("abc"));
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("invalid_id");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("200 revoke: calls revoke_promotionals for THIS member", async () => {
    asAdmin();
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const r = await DELETE(delReq(), ctx());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ data: { revoked: true } });
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.revenuecat.com/v1/subscribers/${MEMBER}/entitlements/content/revoke_promotionals`,
    );
    expect(JSON.parse(String(info.mock.calls[0][0]))).toEqual({
      event: "admin_comp_revoked",
      adminUid: "admin-1",
      targetUid: MEMBER,
    });
  });

  it("502 on RevenueCat failure, 503 without the key", async () => {
    asAdmin();
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 502 }));
    expect((await DELETE(delReq(), ctx())).status).toBe(502);
    vi.stubEnv("REVENUECAT_SECRET_API_KEY", "");
    const r = await DELETE(delReq(), ctx());
    expect(r.status).toBe(503);
    expect((await r.json()).error.code).toBe("revenuecat_not_configured");
  });
});
