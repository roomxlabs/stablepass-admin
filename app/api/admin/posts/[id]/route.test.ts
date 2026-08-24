import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));

import { PATCH, DELETE } from "./route";

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}
function asNonAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: false } } };
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const patchReq = (body: unknown) => new Request("http://t", { method: "PATCH", body: JSON.stringify(body) });

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("DELETE /api/admin/posts/:id — discard draft only", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await DELETE(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(403);
  });

  it("204 when the post is a draft", async () => {
    asAdmin();
    state.tables.post = { select: { single: { status: "draft" } } };
    const r = await DELETE(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(204);
  });

  it("409 when the post is published (soft-hide only, never hard-delete)", async () => {
    asAdmin();
    state.tables.post = { select: { single: { status: "published" } } };
    const r = await DELETE(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error.code).toBe("not_a_draft");
  });

  it("404 when the post is missing", async () => {
    asAdmin();
    state.tables.post = { select: { single: null } };
    const r = await DELETE(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(404);
  });
});

describe("PATCH /api/admin/posts/:id — edit fields", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await PATCH(patchReq({ title: "x" }), ctx("p1"));
    expect(r.status).toBe(403);
  });

  it("edits fields → 200", async () => {
    asAdmin();
    state.tables.post = { mutate: { single: { id: "p1", title: "New" } } };
    const r = await PATCH(patchReq({ title: "New", sourceTrainerId: "t2" }), ctx("p1"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.title).toBe("New");
  });

  it("404 when the post is missing", async () => {
    asAdmin();
    state.tables.post = { mutate: { single: null } };
    const r = await PATCH(patchReq({ title: "New" }), ctx("p1"));
    expect(r.status).toBe(404);
  });

  // ENG-745 — post-label presets.
  it("a valid preset label is written to the label column", async () => {
    asAdmin();
    state.tables.post = { mutate: { single: { id: "p1", label: "Trackwork" } } };
    const r = await PATCH(patchReq({ label: "Trackwork" }), ctx("p1"));
    expect(r.status).toBe(200);
    const updateCall = state.calls.mutations.find((m) => m.table === "post" && m.op === "update");
    expect(updateCall?.payload).toMatchObject({ label: "Trackwork" });
  });

  it("label: null clears the category — update payload carries label: null", async () => {
    asAdmin();
    state.tables.post = { mutate: { single: { id: "p1", label: null } } };
    const r = await PATCH(patchReq({ label: null }), ctx("p1"));
    expect(r.status).toBe(200);
    const updateCall = state.calls.mutations.find((m) => m.table === "post" && m.op === "update");
    expect(updateCall?.payload).toMatchObject({ label: null });
  });

  it("absent label is left alone — the update payload has no label key at all", async () => {
    asAdmin();
    state.tables.post = { mutate: { single: { id: "p1", title: "New" } } };
    await PATCH(patchReq({ title: "New" }), ctx("p1"));
    const updateCall = state.calls.mutations.find((m) => m.table === "post" && m.op === "update");
    expect(updateCall?.payload).not.toHaveProperty("label");
  });

  it("an off-list label ('Betting Tips') → 400 validation_failed, no update attempted", async () => {
    asAdmin();
    const r = await PATCH(patchReq({ label: "Betting Tips" }), ctx("p1"));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
    expect(state.calls.mutations).toHaveLength(0);
  });

  it("update violating the label CHECK (23514) → 400 validation_failed, not update_failed", async () => {
    asAdmin();
    // Postgres names the constraint in the message; PostgREST passes it through.
    state.tables.post = {
      mutate: { error: { code: "23514", message: `new row for relation \"post\" violates check constraint \"post_label_preset\"` } },
    };
    const r = await PATCH(patchReq({ label: "Trackwork" }), ctx("p1"));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
    expect(j.error.message).toContain("13 presets");
  });

  // `post` carries several CHECKs (type, status, aspect_ratio, label) and they
  // all raise 23514. Matching the bare CODE made every one of them report
  // "label must be one of the 13 presets" — including a bad `type`, which is
  // editable through FIELD_MAP with no validation, so it is reachable today.
  it("a 23514 from a DIFFERENT constraint keeps its own message", async () => {
    asAdmin();
    state.tables.post = {
      mutate: {
        error: {
          code: "23514",
          message: 'new row for relation "post" violates check constraint "post_type_check"',
        },
      },
    };
    const r = await PATCH(patchReq({ type: "garbage" }), ctx("p1"));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("update_failed");
    expect(j.error.message).toContain("post_type_check");
    // The operator must not be sent hunting for a label they never touched.
    expect(j.error.message).not.toContain("13 presets");
  });
});

describe("ENG-748 · post_media set + media_url mirror", () => {
  it("403s for a non-admin sending { media: [...] } (guardrail)", async () => {
    asNonAdmin();
    const r = await PATCH(patchReq({ media: ["p1/original"] }), ctx("p1"));
    expect(r.status).toBe(403);
    expect(state.calls.mutations).toHaveLength(0);
  });

  it("a 3-path media set → 200; the post_media upsert carries sort_order 0,1,2 in request order, with the (post_id,sort_order) arbiter", async () => {
    asAdmin();
    state.tables.post = { mutate: { single: { id: "p1" } } };
    const media = ["a/original", "a/photo-1", "a/photo-2"];
    const r = await PATCH(patchReq({ media }), ctx("p1"));
    expect(r.status).toBe(200);
    const upsertCall = state.calls.mutations.find((m) => m.table === "post_media" && m.op === "upsert");
    expect(upsertCall?.payload).toEqual([
      { post_id: "p1", sort_order: 0, media_url: "a/original" },
      { post_id: "p1", sort_order: 1, media_url: "a/photo-1" },
      { post_id: "p1", sort_order: 2, media_url: "a/photo-2" },
    ]);
    expect(upsertCall?.options).toEqual({ onConflict: "post_id,sort_order" });
  });

  // THE MIRROR TEST — the most important one here. A reorder that puts a
  // different path at position 0 must move `post.media_url` WITH it, not
  // leave it pinned at `<id>/original` (which position 0 no longer is).
  it("THE MIRROR: post.media_url follows a reorder to whatever is now at position 0, not to <id>/original", async () => {
    asAdmin();
    state.tables.post = { mutate: { single: { id: "p1" } } };
    const r = await PATCH(
      patchReq({ media: ["p1/photo-2", "p1/original", "p1/photo-1"] }),
      ctx("p1"),
    );
    expect(r.status).toBe(200);
    const updateCall = state.calls.mutations.find((m) => m.table === "post" && m.op === "update");
    expect(updateCall?.payload).toMatchObject({ media_url: "p1/photo-2" });
  });

  it("a single-path media set → mirror equals that path; upsert has exactly one row at sort_order 0", async () => {
    asAdmin();
    state.tables.post = { mutate: { single: { id: "p1" } } };
    const r = await PATCH(patchReq({ media: ["p1/only"] }), ctx("p1"));
    expect(r.status).toBe(200);
    const upsertCall = state.calls.mutations.find((m) => m.table === "post_media" && m.op === "upsert");
    expect(upsertCall?.payload).toEqual([{ post_id: "p1", sort_order: 0, media_url: "p1/only" }]);
    const updateCall = state.calls.mutations.find((m) => m.table === "post" && m.op === "update");
    expect(updateCall?.payload).toMatchObject({ media_url: "p1/only" });
  });

  it("trims the tail: deletes post_media rows scoped to this post at sort_order >= the new set's length", async () => {
    asAdmin();
    state.tables.post = { mutate: { single: { id: "p1" } } };
    const r = await PATCH(patchReq({ media: ["a", "b"] }), ctx("p1"));
    expect(r.status).toBe(200);
    const deleteCall = state.calls.mutations.find((m) => m.table === "post_media" && m.op === "delete");
    // Scoped by post_id (not a bare trim of the whole table) AND by the
    // .gte() ordinal — this is why the fake now records gte's filter at all.
    expect(deleteCall?.filters).toEqual(
      expect.arrayContaining([
        { column: "post_id", value: "p1" },
        { column: "sort_order", value: 2, op: "gte" },
      ]),
    );
  });

  // ORDERING PROOF — the whole design rationale in the route's comment: upsert
  // first (nothing destroyed if it fails), delete second (trims the tail once
  // the head is already correct), post update last (mirror rides along).
  it("ORDERING PROOF: post_media upsert runs before the post_media delete, which runs before the post update", async () => {
    asAdmin();
    state.tables.post = { mutate: { single: { id: "p1" } } };
    await PATCH(patchReq({ media: ["a", "b"] }), ctx("p1"));
    const idxUpsert = state.calls.mutations.findIndex((m) => m.table === "post_media" && m.op === "upsert");
    const idxDelete = state.calls.mutations.findIndex((m) => m.table === "post_media" && m.op === "delete");
    const idxUpdate = state.calls.mutations.findIndex((m) => m.table === "post" && m.op === "update");
    expect(idxUpsert).toBeGreaterThanOrEqual(0);
    expect(idxDelete).toBeGreaterThan(idxUpsert);
    expect(idxUpdate).toBeGreaterThan(idxDelete);
  });

  it("media: [] → 400 validation_failed, no post_media mutation at all", async () => {
    asAdmin();
    const r = await PATCH(patchReq({ media: [] }), ctx("p1"));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
    expect(state.calls.mutations.some((m) => m.table === "post_media")).toBe(false);
  });

  it("media with 11 entries → 400, no post_media mutation", async () => {
    asAdmin();
    const media = Array.from({ length: 11 }, (_, i) => `p1/photo-${i}`);
    const r = await PATCH(patchReq({ media }), ctx("p1"));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
    expect(state.calls.mutations.some((m) => m.table === "post_media")).toBe(false);
  });

  it("a duplicate path in media → 400 validation_failed", async () => {
    asAdmin();
    const r = await PATCH(patchReq({ media: ["a", "a"] }), ctx("p1"));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
  });

  it.each(["https://cdn/x.jpg", "/p1/original"])(
    "media containing %j → 400 (must be a bare object path, never a URL or absolute path)",
    async (badPath) => {
      asAdmin();
      const r = await PATCH(patchReq({ media: [badPath] }), ctx("p1"));
      expect(r.status).toBe(400);
      const j = await r.json();
      expect(j.error.code).toBe("validation_failed");
    },
  );

  it("media in object form ({ mediaUrl }) → 200, works the same as the string form", async () => {
    asAdmin();
    state.tables.post = { mutate: { single: { id: "p1" } } };
    const r = await PATCH(patchReq({ media: [{ mediaUrl: "p1/original" }] }), ctx("p1"));
    expect(r.status).toBe(200);
    const upsertCall = state.calls.mutations.find((m) => m.table === "post_media" && m.op === "upsert");
    expect(upsertCall?.payload).toEqual([{ post_id: "p1", sort_order: 0, media_url: "p1/original" }]);
  });

  // ENG-748 — deploy order. post_media ships in stablepass-be (ENG-740); admin
  // deployed ahead of that migration must not 400 a post that used to work.
  describe("post_media is not deployed yet", () => {
    const missing = {
      mutate: {
        error: {
          code: "PGRST205",
          message: "Could not find the table 'public.post_media' in the schema cache",
        },
      },
    };

    it("a SINGLE photo still saves — the mirror alone is a complete single-photo post", async () => {
      asAdmin();
      state.tables.post_media = missing;
      state.tables.post = { mutate: { single: { id: "p1", media_url: "p1/original" } } };
      const r = await PATCH(patchReq({ media: ["p1/original"] }), ctx("p1"));
      expect(r.status).toBe(200);
      // The mirror was still written, so every existing client renders it.
      const update = state.calls.mutations.find((m) => m.table === "post" && m.op === "update");
      expect(update?.payload).toMatchObject({ media_url: "p1/original" });
      // And no trailing delete was attempted against a table that is not there.
      expect(state.calls.mutations.some((m) => m.table === "post_media" && m.op === "delete")).toBe(false);
    });

    it("a MULTI photo set fails loudly with 503 rather than silently dropping photos", async () => {
      asAdmin();
      state.tables.post_media = missing;
      const r = await PATCH(patchReq({ media: ["p1/original", "p1/photo-1"] }), ctx("p1"));
      expect(r.status).toBe(503);
      const j = await r.json();
      expect(j.error.code).toBe("media_unavailable");
      expect(j.error.message).toContain("post_media");
      // Nothing was written to post either — the save did not half-happen.
      expect(state.calls.mutations.some((m) => m.table === "post" && m.op === "update")).toBe(false);
    });

    it("42P01 is treated the same as the PostgREST cache miss", async () => {
      asAdmin();
      state.tables.post_media = {
        mutate: { error: { code: "42P01", message: 'relation "post_media" does not exist' } },
      };
      state.tables.post = { mutate: { single: { id: "p1" } } };
      expect((await PATCH(patchReq({ media: ["p1/original"] }), ctx("p1"))).status).toBe(200);
    });

    it("does NOT swallow an unrelated failure as a missing table", async () => {
      asAdmin();
      state.tables.post_media = {
        mutate: { error: { code: "42501", message: "new row violates row-level security policy" } },
      };
      const r = await PATCH(patchReq({ media: ["p1/original"] }), ctx("p1"));
      expect(r.status).toBe(400);
      expect((await r.json()).error.code).toBe("update_failed");
    });
  });

  it("a 23505 unique_violation from the upsert → 400 validation_failed, not a 500", async () => {
    asAdmin();
    state.tables.post_media = {
      mutate: { error: { code: "23505", message: "duplicate key value violates unique constraint" } },
    };
    const r = await PATCH(patchReq({ media: ["a", "b"] }), ctx("p1"));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
  });

  it("a 23514 naming post_media_sort_order_range → 400 validation_failed", async () => {
    asAdmin();
    state.tables.post_media = {
      mutate: {
        error: {
          code: "23514",
          message:
            'new row for relation "post_media" violates check constraint "post_media_sort_order_range"',
        },
      },
    };
    const r = await PATCH(patchReq({ media: ["a", "b"] }), ctx("p1"));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
  });

  // Scoped by constraint NAME, exactly as `isLabelCheckViolation` is — a
  // 23514 on `post_media` that ISN'T the sort_order range CHECK must not be
  // reported as a media error; it falls through to the generic update_failed.
  it("a 23514 from a DIFFERENT constraint on post_media falls through to update_failed, not the media message", async () => {
    asAdmin();
    state.tables.post_media = {
      mutate: {
        error: {
          code: "23514",
          message:
            'new row for relation "post_media" violates check constraint "post_media_some_other_check"',
        },
      },
    };
    const r = await PATCH(patchReq({ media: ["a", "b"] }), ctx("p1"));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("update_failed");
    expect(j.error.message).not.toContain("media must be a list");
  });

  it("combined { title, media } → the single post update payload carries BOTH title and media_url", async () => {
    asAdmin();
    state.tables.post = { mutate: { single: { id: "p1" } } };
    const r = await PATCH(patchReq({ title: "New Title", media: ["a/original"] }), ctx("p1"));
    expect(r.status).toBe(200);
    const updateCall = state.calls.mutations.find((m) => m.table === "post" && m.op === "update");
    expect(updateCall?.payload).toMatchObject({ title: "New Title", media_url: "a/original" });
  });

  // Regression: this guard used to be `Object.keys(patch).length === 0` alone,
  // which ENG-748 widened to also require `!("media" in b)` since `media`
  // never lands in `patch` directly (see FIELD_MAP above).
  it("a body with neither editable fields nor media → 400 'No editable fields provided.'", async () => {
    asAdmin();
    const r = await PATCH(patchReq({}), ctx("p1"));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
    expect(j.error.message).toBe("No editable fields provided.");
  });
});
