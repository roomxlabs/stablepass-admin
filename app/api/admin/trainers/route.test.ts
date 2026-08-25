import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
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
  return new Request("http://t/api/admin/trainers", { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("POST /api/admin/trainers — create trainer", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await POST(postReq({ name: "Chris Waller", slug: "chris-waller" }));
    expect(r.status).toBe(403);
  });

  it("creates a trainer → 201 + data", async () => {
    asAdmin();
    state.tables.trainer = { mutate: { single: { id: "t1", name: "Chris Waller", slug: "chris-waller", status: "active" } } };
    const r = await POST(postReq({ name: "Chris Waller", slug: "chris-waller", stableName: "Chris Waller Racing" }));
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.data.id).toBe("t1");
    expect(j.data.slug).toBe("chris-waller");
  });

  it("400s when name or slug is missing", async () => {
    asAdmin();
    const r = await POST(postReq({ name: "No Slug" }));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
  });

  it("409s when the slug is already taken (unique violation)", async () => {
    asAdmin();
    state.tables.trainer = { mutate: { error: { code: "23505", message: "duplicate key" } } };
    const r = await POST(postReq({ name: "Chris Waller", slug: "chris-waller" }));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error.code).toBe("slug_taken");
  });

  it("records marketing_visible=true on the insert when the toggle is on", async () => {
    asAdmin();
    state.tables.trainer = { mutate: { single: { id: "t1", name: "X", slug: "x", status: "active", marketing_visible: true } } };
    const r = await POST(postReq({ name: "X", slug: "x", marketingVisible: true }));
    expect(r.status).toBe(201);
    const ins = state.calls.mutations.find((m) => m.table === "trainer" && m.op === "insert");
    expect(ins?.payload.marketing_visible).toBe(true);
  });

  it("defaults marketing_visible to false when the toggle is absent (nothing publishes by accident)", async () => {
    asAdmin();
    state.tables.trainer = { mutate: { single: { id: "t1", name: "X", slug: "x", status: "active", marketing_visible: false } } };
    const r = await POST(postReq({ name: "X", slug: "x" }));
    expect(r.status).toBe(201);
    const ins = state.calls.mutations.find((m) => m.table === "trainer" && m.op === "insert");
    expect(ins?.payload.marketing_visible).toBe(false);
  });

  it("400s when marketingVisible is not a boolean", async () => {
    asAdmin();
    const r = await POST(postReq({ name: "X", slug: "x", marketingVisible: "yes" }));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
  });

  it("persists website_url on create", async () => {
    asAdmin();
    state.tables.trainer = { mutate: { single: { id: "t1", name: "X", slug: "x", status: "active" } } };
    const r = await POST(postReq({ name: "X", slug: "x", websiteUrl: "https://wallerracing.com.au" }));
    expect(r.status).toBe(201);
    const ins = state.calls.mutations.find((m) => m.table === "trainer" && m.op === "insert");
    expect(ins?.payload.website_url).toBe("https://wallerracing.com.au");
  });

  it("trims a website before storing it", async () => {
    asAdmin();
    state.tables.trainer = { mutate: { single: { id: "t1", name: "X", slug: "x", status: "active" } } };
    const r = await POST(postReq({ name: "X", slug: "x", websiteUrl: "  https://wallerracing.com.au  " }));
    expect(r.status).toBe(201);
    const ins = state.calls.mutations.find((m) => m.table === "trainer" && m.op === "insert");
    expect(ins?.payload.website_url).toBe("https://wallerracing.com.au");
  });

  it("stores an empty website as null", async () => {
    asAdmin();
    state.tables.trainer = { mutate: { single: { id: "t1", name: "X", slug: "x", status: "active" } } };
    const r = await POST(postReq({ name: "X", slug: "x", websiteUrl: "" }));
    expect(r.status).toBe(201);
    const ins = state.calls.mutations.find((m) => m.table === "trainer" && m.op === "insert");
    expect(ins?.payload.website_url).toBe(null);
  });

  it("stores an omitted website as null", async () => {
    asAdmin();
    state.tables.trainer = { mutate: { single: { id: "t1", name: "X", slug: "x", status: "active" } } };
    const r = await POST(postReq({ name: "X", slug: "x" }));
    expect(r.status).toBe(201);
    const ins = state.calls.mutations.find((m) => m.table === "trainer" && m.op === "insert");
    expect(ins?.payload.website_url).toBe(null);
  });

  it("400s on a javascript: url (never reaches the database)", async () => {
    asAdmin();
    const r = await POST(postReq({ name: "X", slug: "x", websiteUrl: "javascript:alert(1)" }));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
    // The refusal happens before the insert is ever attempted.
    const ins = state.calls.mutations.find((m) => m.table === "trainer");
    expect(ins).toBeUndefined();
  });

  it("400s on a bare domain (web would render no link for it)", async () => {
    asAdmin();
    const r = await POST(postReq({ name: "X", slug: "x", websiteUrl: "wallerracing.com.au" }));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
  });

  // ENG-746 mutation guard: parseWebsiteUrl's `typeof raw !== "string"` branch
  // must reject anything that is not a string before it can reach the insert.
  // A non-string is a malformed body, not an empty field, so it must 400 -
  // never fall through and get written to trainer.website_url raw.
  // Each case is wrapped in its OWN array. vitest's `each` SPREADS an array
  // element into arguments, so the bare form silently unwrapped
  // `["https://x.com"]` into the string "https://x.com" and tested the opposite
  // of what it claimed. The tuple form also removes the `it.each` typing error
  // that unwrapping produced.
  it.each([[42], [true], [{}], [["https://x.com"]], [{ toString: "x" }]])(
    "400s when websiteUrl is a non-string value (%j), no insert attempted",
    async (websiteUrl) => {
      asAdmin();
      // A fixture that WOULD let a valid insert succeed with 201. Without it the
      // route 400s for a missing-table reason and the assertion below passes
      // whether or not validation ran, proving nothing.
      state.tables.trainer = { mutate: { single: { id: "t1", name: "X", slug: "x", status: "active" } } };
      const r = await POST(postReq({ name: "X", slug: "x", websiteUrl }));
      expect(r.status).toBe(400);
      const j = await r.json();
      expect(j.error.code).toBe("validation_failed");
      const ins = state.calls.mutations.find((m) => m.table === "trainer");
      expect(ins).toBeUndefined();
    },
  );

  it("echoes website_url back to the form", async () => {
    // lib/testing/supabase-fake.ts's builder does not record the `.select()`
    // argument (its `select` method is a no-op passthrough), so there is
    // nothing on `state.calls` to assert through. Reading the route source
    // directly is the only way to prove the echo list carries the column.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    const selectCall = src.match(/\.select\("([^"]+)"\)/);
    expect(selectCall?.[1]).toContain("website_url");
  });
});
