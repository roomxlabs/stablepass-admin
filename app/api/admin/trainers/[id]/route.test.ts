import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));

import { PATCH } from "./route";

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}
function asNonAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: false } } };
}
function patchReq(body: unknown): Request {
  return new Request("http://t/api/admin/trainers/t1", { method: "PATCH", body: JSON.stringify(body) });
}
const ctx = { params: Promise.resolve({ id: "t1" }) };

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("PATCH /api/admin/trainers/:id — update trainer", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await PATCH(patchReq({ status: "onboarding" }), ctx);
    expect(r.status).toBe(403);
  });

  it("updates present fields → 200", async () => {
    asAdmin();
    state.tables.trainer = { mutate: { single: { id: "t1", name: "Chris Waller", status: "onboarding" } } };
    const r = await PATCH(patchReq({ status: "onboarding", location: "Rosehill, NSW" }), ctx);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.status).toBe("onboarding");
  });

  it("404s when the trainer does not exist (no row)", async () => {
    asAdmin();
    state.tables.trainer = { mutate: { error: { code: "PGRST116", message: "no rows" } } };
    const r = await PATCH(patchReq({ name: "X" }), ctx);
    expect(r.status).toBe(404);
    const j = await r.json();
    expect(j.error.code).toBe("not_found");
  });

  it("patches marketing_visible when the toggle flips on", async () => {
    asAdmin();
    state.tables.trainer = { mutate: { single: { id: "t1" } } };
    const r = await PATCH(patchReq({ marketingVisible: true }), ctx);
    expect(r.status).toBe(200);
    const upd = state.calls.mutations.find((m) => m.table === "trainer" && m.op === "update");
    expect(upd?.payload.marketing_visible).toBe(true);
  });

  it("patches marketing_photo_path when the public copy lands", async () => {
    asAdmin();
    state.tables.trainer = { mutate: { single: { id: "t1" } } };
    const r = await PATCH(patchReq({ marketingPhotoPath: "trainers/t1.jpg" }), ctx);
    expect(r.status).toBe(200);
    const upd = state.calls.mutations.find((m) => m.table === "trainer" && m.op === "update");
    expect(upd?.payload.marketing_photo_path).toBe("trainers/t1.jpg");
  });

  it("nulls marketing_photo_path when the trainer is taken off the site", async () => {
    asAdmin();
    state.tables.trainer = { mutate: { single: { id: "t1" } } };
    const r = await PATCH(patchReq({ marketingVisible: false, marketingPhotoPath: null }), ctx);
    expect(r.status).toBe(200);
    const upd = state.calls.mutations.find((m) => m.table === "trainer" && m.op === "update");
    // A null path MUST survive the validation — this is the un-publish path.
    expect(upd?.payload.marketing_photo_path).toBe(null);
    expect(upd?.payload.marketing_visible).toBe(false);
  });

  it("400s on an absolute marketing photo path", async () => {
    asAdmin();
    const r = await PATCH(patchReq({ marketingPhotoPath: "/etc/passwd" }), ctx);
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
  });

  it("400s on a traversal marketing photo path", async () => {
    asAdmin();
    const r = await PATCH(patchReq({ marketingPhotoPath: "../trainer-photos/x.jpg" }), ctx);
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
  });

  it("400s when marketingVisible is not a boolean", async () => {
    asAdmin();
    const r = await PATCH(patchReq({ marketingVisible: "yes" }), ctx);
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
  });

  it("patches website_url", async () => {
    asAdmin();
    state.tables.trainer = { mutate: { single: { id: "t1" } } };
    const r = await PATCH(patchReq({ websiteUrl: "https://wallerracing.com.au" }), ctx);
    expect(r.status).toBe(200);
    const upd = state.calls.mutations.find((m) => m.table === "trainer" && m.op === "update");
    expect(upd?.payload.website_url).toBe("https://wallerracing.com.au");
  });

  it("trims the website before writing", async () => {
    asAdmin();
    state.tables.trainer = { mutate: { single: { id: "t1" } } };
    const r = await PATCH(patchReq({ websiteUrl: "  https://wallerracing.com.au  " }), ctx);
    expect(r.status).toBe(200);
    const upd = state.calls.mutations.find((m) => m.table === "trainer" && m.op === "update");
    expect(upd?.payload.website_url).toBe("https://wallerracing.com.au");
  });

  it("clears the website when the field is emptied", async () => {
    asAdmin();
    state.tables.trainer = { mutate: { single: { id: "t1" } } };
    const r = await PATCH(patchReq({ websiteUrl: "" }), ctx);
    expect(r.status).toBe(200);
    const upd = state.calls.mutations.find((m) => m.table === "trainer" && m.op === "update");
    // A null website MUST survive the validation - this is the un-set path.
    expect(upd?.payload.website_url).toBe(null);
  });

  it("clears the website when explicitly null", async () => {
    asAdmin();
    state.tables.trainer = { mutate: { single: { id: "t1" } } };
    const r = await PATCH(patchReq({ websiteUrl: null }), ctx);
    expect(r.status).toBe(200);
    const upd = state.calls.mutations.find((m) => m.table === "trainer" && m.op === "update");
    expect(upd?.payload.website_url).toBe(null);
  });

  it("400s on a javascript: url", async () => {
    asAdmin();
    const r = await PATCH(patchReq({ websiteUrl: "javascript:alert(1)" }), ctx);
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
    const upd = state.calls.mutations.find((m) => m.table === "trainer" && m.op === "update");
    expect(upd).toBeUndefined();
  });

  it("400s on a bare domain", async () => {
    asAdmin();
    const r = await PATCH(patchReq({ websiteUrl: "wallerracing.com.au" }), ctx);
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
  });

  it("leaves website_url untouched when the key is absent", async () => {
    asAdmin();
    state.tables.trainer = { mutate: { single: { id: "t1" } } };
    const r = await PATCH(patchReq({ location: "X" }), ctx);
    expect(r.status).toBe(200);
    const upd = state.calls.mutations.find((m) => m.table === "trainer" && m.op === "update");
    expect("website_url" in upd!.payload).toBe(false);
  });

  // ENG-746 mutation guard: the presence gate is `"websiteUrl" in (b ?? {})`,
  // not a `typeof` check, precisely so a non-string value still reaches
  // parseWebsiteUrl and gets rejected instead of skipping validation and
  // being copied raw into website_url by the FIELD_MAP loop below.
  // Each case is wrapped in its OWN array: vitest's `each` SPREADS an array
  // element into arguments, so the bare form silently unwrapped
  // `["https://x.com"]` into a plain string and tested the opposite of what it
  // claimed. The tuple form also fixes the `it.each` typing error.
  it.each([[42], [true], [{}], [["https://x.com"]], [{ toString: "x" }]])(
    "400s when websiteUrl is a non-string value (%j), no update attempted",
    async (websiteUrl) => {
      asAdmin();
      // A fixture that WOULD let a valid update succeed with 200, so the 400
      // below can only come from validation rather than from a missing table.
      state.tables.trainer = { mutate: { single: { id: "t1" } } };
      const r = await PATCH(patchReq({ websiteUrl }), ctx);
      expect(r.status).toBe(400);
      const j = await r.json();
      expect(j.error.code).toBe("validation_failed");
      const upd = state.calls.mutations.find((m) => m.table === "trainer" && m.op === "update");
      expect(upd).toBeUndefined();
    },
  );

  it("echoes website_url back", async () => {
    // Same reasoning as app/api/admin/trainers/route.test.ts: the fake's
    // builder never records the `.select()` argument, so the only way to
    // prove the echo list carries the column is to read the route source.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    const selectCall = src.match(/\.select\("([^"]+)"\)/);
    expect(selectCall?.[1]).toContain("website_url");
  });
});
