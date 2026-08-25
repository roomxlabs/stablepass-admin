import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";
import { recordCalls, blankRecord, type CallRecord } from "@/lib/testing/call-recorder";

const state: FakeState = blankState();
// The shared fake's query builder SWALLOWS its arguments, so on its own it
// cannot tell a correct insert from a wrong one. Wrap it in a recorder and
// assert the PAYLOAD, not just the absence of an `error`.
const rec: CallRecord = blankRecord();
vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => recordCalls(makeFakeClient(state), rec),
}));

import { POST } from "./route";

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}
function asNonAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: false } } };
}
function postReq(body: unknown): Request {
  return new Request("http://t/api/admin/horses", { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => {
  Object.assign(state, blankState());
  Object.assign(rec, blankRecord());
});

describe("POST /api/admin/horses — create", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await POST(postReq({ trainerId: "t1" }));
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("forbidden");
    // The gate must run BEFORE any horse write, not alongside it.
    expect(rec.writes).toEqual([]);
  });

  it("creates a horse -> 201", async () => {
    asAdmin();
    state.tables.horse = { mutate: { single: { id: "h1", display_name: "Mahogany" } } };
    const r = await POST(
      postReq({
        trainerId: "t1",
        stableName: "Mahogany",
        sire: "Snitzel",
        dam: "Polar Success",
        sex: "male",
        isGelded: true,
        colour: "Bay",
        foalingYear: 2020,
        trainingStatus: "racing",
        status: "active",
        starts: 24,
        wins: 6,
        places: 9,
        prizeMoneyCents: 1200000,
      }),
    );
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.data.id).toBe("h1");
    expect(j.data.display_name).toBe("Mahogany");
  });

  it("400 when trainerId is missing", async () => {
    asAdmin();
    const r = await POST(postReq({ sire: "Snitzel" }));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
  });
});

describe("POST /api/admin/horses — sex + gelded (ENG-616)", () => {
  beforeEach(() => {
    asAdmin();
    state.tables.horse = { mutate: { single: { id: "h1" } } };
  });

  it("accepts {sex:'male', isGelded:true} and WRITES both columns", async () => {
    const r = await POST(postReq({ trainerId: "t1", stableName: "Mahogany", sex: "male", isGelded: true }));
    expect(r.status).toBe(201);
    expect(rec.writes).toHaveLength(1);
    expect(rec.writes[0].table).toBe("horse");
    expect(rec.writes[0].op).toBe("insert");
    // Payload-level, not just "no error": a swallowing mock would pass either way.
    expect(rec.writes[0].payload).toMatchObject({ sex: "male", is_gelded: true });
  });

  it("accepts {sex:'female'} and writes is_gelded false", async () => {
    const r = await POST(postReq({ trainerId: "t1", stableName: "Winx", sex: "female", isGelded: false }));
    expect(r.status).toBe(201);
    expect(rec.writes[0].payload).toMatchObject({ sex: "female", is_gelded: false });
  });

  it("rejects {sex:'female', isGelded:true} as 400 validation_failed — OUR error, not Postgres 23514", async () => {
    const r = await POST(postReq({ trainerId: "t1", sex: "female", isGelded: true }));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
    expect(j.error.message).toMatch(/isGelded/);
    // Never reached the database, so the CHECK never had to catch it.
    expect(rec.writes).toEqual([]);
  });

  it("rejects isGelded:true with no sex at all", async () => {
    const r = await POST(postReq({ trainerId: "t1", isGelded: true }));
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("validation_failed");
    expect(rec.writes).toEqual([]);
  });

  it("rejects a legacy race-day description in sex", async () => {
    for (const legacy of ["gelding", "colt", "filly", "mare", "stallion"]) {
      Object.assign(rec, blankRecord());
      const r = await POST(postReq({ trainerId: "t1", sex: legacy }));
      expect(r.status, legacy).toBe(400);
      expect((await r.json()).error.code).toBe("validation_failed");
      expect(rec.writes, legacy).toEqual([]);
    }
  });

  it("accepts a null sex (an unmapped legacy row stays unknown)", async () => {
    const r = await POST(postReq({ trainerId: "t1", stableName: "Mystery", sex: null, isGelded: false }));
    expect(r.status).toBe(201);
    expect(rec.writes[0].payload).toMatchObject({ sex: null, is_gelded: false });
  });

  it("writes is_gelded false when creating a female with no gelding stated", async () => {
    const r = await POST(postReq({ trainerId: "t1", stableName: "Winx", sex: "female" }));
    expect(r.status).toBe(201);
    expect(rec.writes[0].payload).toMatchObject({ sex: "female", is_gelded: false });
  });

  it("returns a generic message on a database error, never the Postgres text", async () => {
    state.tables.horse = {
      mutate: { error: { code: "23514", message: 'violates check constraint "horse_gelded_implies_male"' } },
    };
    const r = await POST(postReq({ trainerId: "t1", sex: "male" }));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.message).not.toMatch(/constraint|horse_gelded|relation/i);
  });

  it("rejects a non-boolean isGelded", async () => {
    const r = await POST(postReq({ trainerId: "t1", sex: "male", isGelded: "true" }));
    expect(r.status).toBe(400);
    expect(rec.writes).toEqual([]);
  });

  it("never writes an owner column, whatever the caller sends (guardrail: no owner PII)", async () => {
    const r = await POST(
      postReq({ trainerId: "t1", stableName: "Mahogany", sex: "male", owner: "Jane Doe", owner_email: "j@x.com" }),
    );
    expect(r.status).toBe(201);
    const payload = rec.writes[0].payload as Record<string, unknown>;
    expect(Object.keys(payload).filter((k) => k.includes("owner"))).toEqual([]);
  });
});

describe("POST /api/admin/horses — shares_for_sale (ENG-829)", () => {
  beforeEach(() => {
    asAdmin();
    state.tables.horse = { mutate: { single: { id: "h1", shares_for_sale: true } } };
  });

  it("persists shares_for_sale=true when the trainer has a website_url", async () => {
    state.tables.trainer = {
      select: { single: { id: "t1", website_url: "https://wallerracing.com.au" } },
    };
    const r = await POST(postReq({ trainerId: "t1", stableName: "Mahogany", sharesForSale: true }));
    expect(r.status).toBe(201);
    expect(rec.writes[0].payload).toMatchObject({ shares_for_sale: true });
    // Boolean only — no price / vendor / share-count (guardrails 4/6).
    const keys = Object.keys(rec.writes[0].payload as object);
    expect(keys.filter((k) => /price|owner|vendor|share_count/i.test(k))).toEqual([]);
  });

  it("persists shares_for_sale=false", async () => {
    const r = await POST(postReq({ trainerId: "t1", stableName: "Mahogany", sharesForSale: false }));
    expect(r.status).toBe(201);
    expect(rec.writes[0].payload).toMatchObject({ shares_for_sale: false });
    // Turning off must not require a trainer website lookup.
    expect(rec.selects.filter((s) => s.startsWith("trainer:"))).toEqual([]);
  });

  it("400s with the form copy when sharesForSale=true and website_url is null", async () => {
    state.tables.trainer = { select: { single: { id: "t1", website_url: null } } };
    const r = await POST(postReq({ trainerId: "t1", stableName: "Mahogany", sharesForSale: true }));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
    expect(j.error.message).toMatch(/Set this trainer's website first/);
    expect(rec.writes).toEqual([]);
  });

  it("400s when sharesForSale is not a boolean", async () => {
    const r = await POST(postReq({ trainerId: "t1", sharesForSale: "yes" }));
    expect(r.status).toBe(400);
    expect(rec.writes).toEqual([]);
  });
});
