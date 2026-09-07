import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";
import { POST_LABEL_PRESETS } from "@/lib/posts/labels";

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
    expect(j.error.message).toContain(`${POST_LABEL_PRESETS.length} presets`);
  });

  // `post` carries several CHECKs (type, status, aspect_ratio, label) and they
  // all raise 23514. Matching the bare CODE made every one of them report
  // "label must be one of the presets" — including a bad `type`, which is
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
    expect(j.error.message).not.toContain(`${POST_LABEL_PRESETS.length} presets`);
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
    const media = ["p1/original", "p1/photo-1", "p1/photo-2"];
    const r = await PATCH(patchReq({ media }), ctx("p1"));
    expect(r.status).toBe(200);
    const upsertCall = state.calls.mutations.find((m) => m.table === "post_media" && m.op === "upsert");
    expect(upsertCall?.payload).toEqual([
      { post_id: "p1", sort_order: 0, media_url: "p1/original" },
      { post_id: "p1", sort_order: 1, media_url: "p1/photo-1" },
      { post_id: "p1", sort_order: 2, media_url: "p1/photo-2" },
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
    const r = await PATCH(patchReq({ media: ["p1/original", "p1/photo-1"] }), ctx("p1"));
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
  // ENG-748 F1 — the ordering is the durability design, so it is pinned as a
  // test rather than left to a comment. Reversed in review: `post` (carrying
  // the mirror) must be written BEFORE post_media, so that the realistic
  // failure — a rejected post field — cannot leave rewritten ordered rows
  // behind an unmoved mirror.
  it("ORDERING PROOF: the post update (with the mirror) runs BEFORE post_media is touched", async () => {
    asAdmin();
    state.tables.post = { mutate: { single: { id: "p1" } } };
    await PATCH(patchReq({ media: ["p1/original", "p1/photo-1"] }), ctx("p1"));
    const idxUpdate = state.calls.mutations.findIndex((m) => m.table === "post" && m.op === "update");
    const idxUpsert = state.calls.mutations.findIndex((m) => m.table === "post_media" && m.op === "upsert");
    const idxDelete = state.calls.mutations.findIndex((m) => m.table === "post_media" && m.op === "delete");
    expect(idxUpdate).toBeGreaterThanOrEqual(0);
    expect(idxUpsert).toBeGreaterThan(idxUpdate);
    // The trim runs last: by then rows 0..n-1 and the mirror are already right,
    // so a trim failure leaves stale TRAILING rows, which the next save fixes.
    expect(idxDelete).toBeGreaterThan(idxUpsert);
  });

  it("F1 REGRESSION: a failed post update leaves post_media COMPLETELY untouched", async () => {
    // The divergence found in review. Before the reorder, the upsert and trim
    // had already run by the time the post update failed, so post_media row 0
    // was the new cover while post.media_url still pointed at the old one —
    // silent and durable, on a response that told the operator it had failed.
    asAdmin();
    state.tables.post = {
      mutate: { error: { code: "22007", message: "invalid input syntax" } },
    };
    const r = await PATCH(
      patchReq({ media: ["p1/photo-2", "p1/original"], expiresAt: "not-a-date" }),
      ctx("p1"),
    );
    expect(r.status).toBe(400);
    // Nothing was written to the ordered table, so the previous set is still
    // readable AND still agrees with the mirror that was never moved.
    expect(state.calls.mutations.some((m) => m.table === "post_media")).toBe(false);
  });

  it("F1 REGRESSION: a missing post (404) also leaves post_media untouched", async () => {
    asAdmin();
    state.tables.post = { mutate: { single: null } };
    // Path is prefixed with the post being addressed, so it passes validation
    // and actually reaches the post update — which is what makes this a real
    // 404 test. It also pins reviewer advisory 11: because the post update now
    // runs BEFORE post_media, a missing post returns the contract's 404 rather
    // than a 400 from the post_media foreign key firing first.
    const r = await PATCH(patchReq({ media: ["gone/original"] }), ctx("gone"));
    expect(r.status).toBe(404);
    expect(state.calls.mutations.some((m) => m.table === "post_media")).toBe(false);
  });

  it("F1 REGRESSION: a rejected label rejects the whole save without rewriting the order", async () => {
    // A label rejection must land BEFORE the media rows are rewritten — the
    // regression this test was written for.
    //
    // ENG-979 changed WHICH label gets rejected here, not the ordering rule.
    // "Not A Real Preset" used to 400 at the validator; it no longer does,
    // because the live allowed set is now `post_label` and only the database
    // knows it (an unknown name comes back as a 23503 instead — see the test
    // below). A guardrail-6 name is still refused up front, so it is what
    // exercises this ordering guarantee now.
    asAdmin();
    const r = await PATCH(
      patchReq({ media: ["p1/photo-2", "p1/original"], label: "Betting Tips" }),
      ctx("p1"),
    );
    expect(r.status).toBe(400);
    expect(state.calls.mutations.some((m) => m.table === "post_media")).toBe(false);
  });

  it("ENG-979: an unknown-but-well-formed label reaches the DB and 400s on the FK", async () => {
    // The other half of the change above. A name that breaks no admin-side rule
    // is now passed through to Postgres, where `post_label_name_fk` is the
    // authority on whether the category exists. This is the path that makes a
    // runtime-added label usable at all, so it must stay reachable.
    asAdmin();
    state.tables.post = {
      mutate: {
        error: {
          code: "23503",
          message:
            'insert or update on table "post" violates foreign key constraint "post_label_name_fk"',
        },
      },
    };
    const r = await PATCH(patchReq({ label: "Not A Real Preset" }), ctx("p1"));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
  });

  // ENG-748 C3/C4 (mutations that SURVIVED the first review) — the module's doc
  // comment makes load-bearing claims that nothing was testing.
  it("C3: IGNORES a wire-supplied sortOrder and numbers by position instead", async () => {
    // "A client-supplied sortOrder is exactly how a gapped {0,3,7} set reaches
    // a table whose CHECK cannot see it." Mutating normaliseMediaSet to honour
    // entry.sortOrder left the whole suite green before this test existed.
    asAdmin();
    state.tables.post = { mutate: { single: { id: "p1" } } };
    const r = await PATCH(
      patchReq({
        media: [
          { mediaUrl: "p1/photo-7", sortOrder: 7 },
          { mediaUrl: "p1/photo-3", sortOrder: 3 },
        ],
      }),
      ctx("p1"),
    );
    expect(r.status).toBe(200);
    const upsert = state.calls.mutations.find((m) => m.table === "post_media" && m.op === "upsert");
    // Contiguous 0,1 from ARRAY POSITION — not 7,3 from the wire.
    expect(upsert?.payload).toEqual([
      { post_id: "p1", sort_order: 0, media_url: "p1/photo-7" },
      { post_id: "p1", sort_order: 1, media_url: "p1/photo-3" },
    ]);
  });

  it("C4: the mirror carries the NORMALISED path, byte-identical to row 0", async () => {
    // Taking the mirror from the raw b.media[0] instead of rows[0] survived,
    // because the only difference on tested input was .trim(). A padded path
    // would then write a trimmed value to post_media and an untrimmed one to
    // post.media_url — mirror != row 0, the exact invariant this ticket holds.
    asAdmin();
    state.tables.post = { mutate: { single: { id: "p1" } } };
    const r = await PATCH(patchReq({ media: ["  p1/original  ", "p1/photo-1"] }), ctx("p1"));
    expect(r.status).toBe(200);
    const upsert = state.calls.mutations.find((m) => m.table === "post_media" && m.op === "upsert");
    const update = state.calls.mutations.find((m) => m.table === "post" && m.op === "update");
    expect(upsert?.payload[0].media_url).toBe("p1/original");
    expect(update?.payload.media_url).toBe("p1/original");
    // The invariant itself, asserted directly rather than via two literals.
    expect(update?.payload.media_url).toBe(upsert?.payload[0].media_url);
  });

  it("refuses another post's object rather than cross-linking it into this set", async () => {
    // <postId>/... is ENG-740's convention; an object under a DIFFERENT post is
    // not a member of this post's set. Without the prefix check this wrote B's
    // object into A's row 0 and therefore into A's mirror.
    asAdmin();
    const r = await PATCH(patchReq({ media: ["other-post/original"] }), ctx("p1"));
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("validation_failed");
    expect(state.calls.mutations.some((m) => m.table === "post_media")).toBe(false);
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
    const r = await PATCH(patchReq({ media: ["p1/original", "p1/original"] }), ctx("p1"));
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
      // The post update runs FIRST now (F1), so it has to succeed before the
      // media write is even attempted.
      state.tables.post = { mutate: { single: { id: "p1" } } };
      const r = await PATCH(patchReq({ media: ["p1/original", "p1/photo-1"] }), ctx("p1"));
      expect(r.status).toBe(503);
      const j = await r.json();
      expect(j.error.code).toBe("media_unavailable");
      expect(j.error.message).toContain("post_media");
      // The post update DID land, and that is deliberate (F1): it runs first,
      // so the operator keeps their caption and the post renders as a single
      // photo showing the cover they chose, rather than losing the edit too.
      const update = state.calls.mutations.find((m) => m.table === "post" && m.op === "update");
      expect(update?.payload).toMatchObject({ media_url: "p1/original" });
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
      state.tables.post = { mutate: { single: { id: "p1" } } };
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
    state.tables.post = { mutate: { single: { id: "p1" } } };
    const r = await PATCH(patchReq({ media: ["p1/original", "p1/photo-1"] }), ctx("p1"));
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
    state.tables.post = { mutate: { single: { id: "p1" } } };
    const r = await PATCH(patchReq({ media: ["p1/original", "p1/photo-1"] }), ctx("p1"));
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
    state.tables.post = { mutate: { single: { id: "p1" } } };
    const r = await PATCH(patchReq({ media: ["p1/original", "p1/photo-1"] }), ctx("p1"));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("update_failed");
    expect(j.error.message).not.toContain("media must be a list");
  });

  it("combined { title, media } → the single post update payload carries BOTH title and media_url", async () => {
    asAdmin();
    state.tables.post = { mutate: { single: { id: "p1", title: "New Title" } } };
    const r = await PATCH(patchReq({ title: "New Title", media: ["p1/original"] }), ctx("p1"));
    expect(r.status).toBe(200);
    const updateCall = state.calls.mutations.find((m) => m.table === "post" && m.op === "update");
    expect(updateCall?.payload).toMatchObject({ title: "New Title", media_url: "p1/original" });
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
