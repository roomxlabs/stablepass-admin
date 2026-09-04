import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";
import { recordCalls, blankRecord, type CallRecord } from "@/lib/testing/call-recorder";

const state: FakeState = blankState();
const rec: CallRecord = blankRecord();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => recordCalls(makeFakeClient(state), rec),
}));

import { GET } from "./route";

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}
function asNonAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: false } } };
}
function req(qs = ""): Request {
  return new Request(`http://t/api/admin/subscribers${qs}`);
}

beforeEach(() => {
  Object.assign(state, blankState());
  Object.assign(rec, blankRecord());
});

describe("GET /api/admin/subscribers", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await GET(req());
    expect(r.status).toBe(403);
  });

  // The tallies are now one `{ count: "exact", head: true }` per status —
  // trial, active, lapsed, canceled, in SUBSCRIPTION_STATUSES order — instead of
  // a fetch of every subscription row followed by a JS tally. Staff exclusion
  // moved with them, into a filter on the `!inner` app_user embed.
  it("returns aggregate counts by status (no member PII)", async () => {
    asAdmin();
    state.tables.subscription = {
      selectQueue: [{ count: 1 }, { count: 2 }, { count: 0 }, { count: 1 }],
    };
    const r = await GET(req());
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.total).toBe(4);
    // `lapsed: 0` stays ABSENT — the tally-from-rows version never emitted a
    // zero either, and this response shape is asserted key-for-key.
    expect(j.data.byStatus).toEqual({ active: 2, trial: 1, canceled: 1 });
    // Aggregate-only guardrail: never leak a user_id / member row.
    expect(JSON.stringify(j.data)).not.toContain("user_id");
  });

  it("counts with head:true and excludes staff in the query, not in JS", async () => {
    asAdmin();
    state.tables.subscription = { select: { count: 0 } };
    await GET(req());

    const counts = rec.selectOptions.filter((o) => o.table === "subscription");
    expect(counts).toHaveLength(4);
    for (const c of counts) expect(c).toMatchObject({ count: "exact", head: true });

    // `not.is.true`, never `eq.false`: `is_admin` may be null on an ordinary
    // member, and `eq.false` would quietly drop them from every tally.
    expect(rec.nots).toContain("subscription.user.is_admin=not.is.true");
    expect(rec.nots.some((n) => n.includes("eq.false"))).toBe(false);
  });

  it("asks about ONE status only when the query narrows it", async () => {
    asAdmin();
    state.tables.subscription = { select: { count: 7 } };
    const r = await GET(req("?status=trial"));
    const j = await r.json();
    expect(j.data.byStatus).toEqual({ trial: 7 });
    expect(rec.selectOptions.filter((o) => o.table === "subscription")).toHaveLength(1);
    expect(rec.filters).toContain("subscription.status=trial");
  });

  it("returns an empty aggregate when there are no subscribers", async () => {
    asAdmin();
    const r = await GET(req("?status=active"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.total).toBe(0);
    expect(j.data.byStatus).toEqual({});
  });
});
