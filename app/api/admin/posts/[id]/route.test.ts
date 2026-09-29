import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";
import { POST_LABEL_PRESETS } from "@/lib/posts/labels";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));

// ENG-1597 — `cleanupVideos` (via lib/posts/videos.ts) calls out to Mux. Mocked
// here the same way app/api/admin/posts/route.test.ts mocks it, so a route
// test can assert WHICH ids cleanup ran for without any real network access.
const cleanupMuxVideo = vi.fn<
  (v: { videoId: string; assetId?: string | null; uploadId?: string | null }) => Promise<void>
>(async () => undefined);
vi.mock("@/lib/mux", () => ({
  MuxError: class MuxError extends Error {},
  createMuxDirectUpload: vi.fn(),
  // Mirrors the real `cleanupMuxVideo`'s own contract (lib/mux.ts): it NEVER
  // rejects — any failure is caught and swallowed internally. The route's own
  // `await cleanupVideos(...)` carries no try/catch of its own; it relies
  // entirely on that contract. Wrapping the spy the same way lets a test
  // actually simulate a failure (`cleanupMuxVideo.mockRejectedValueOnce(...)`)
  // and still prove the route survives it, rather than calling a spy that
  // already resolves by default and proves nothing (see "a Mux cleanup
  // failure never turns a successful save into a non-200" below).
  cleanupMuxVideo: async (v: { videoId: string; assetId?: string | null; uploadId?: string | null }) => {
    try {
      await cleanupMuxVideo(v);
    } catch {
      // swallowed, exactly like the real implementation.
    }
  },
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
  cleanupMuxVideo.mockClear();
});

describe("DELETE /api/admin/posts/:id — discard draft only", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await DELETE(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(403);
  });

  it("204 when the post is a draft", async () => {
    asAdmin();
    // ENG-1597 — the delete now scopes `.select("id")` off the mutation, so a
    // successful discard has to return the row it actually removed.
    state.tables.post = { select: { single: { status: "draft" } }, mutate: { rows: [{ id: "p1" }] } };
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

  // ENG-1597 — a discarded video draft's rows must not leak Mux assets/uploads.
  it("204 for a video draft → cleans up every one of its post_video rows' Mux assets/uploads", async () => {
    asAdmin();
    state.tables.post = { select: { single: { status: "draft" } }, mutate: { rows: [{ id: "p1" }] } };
    state.tables.post_video = {
      select: {
        rows: [
          { id: "pv0", sort_order: 0, status: "ready", mux_upload_id: null, mux_asset_id: "as_0" },
          { id: "pv1", sort_order: 1, status: "uploading", mux_upload_id: "up_1", mux_asset_id: null },
        ],
      },
    };
    const r = await DELETE(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(204);
    expect(cleanupMuxVideo).toHaveBeenCalledWith({ videoId: "pv0", assetId: "as_0", uploadId: null });
    expect(cleanupMuxVideo).toHaveBeenCalledWith({ videoId: "pv1", assetId: null, uploadId: "up_1" });
  });

  it("a failed post delete → no cleanup call at all", async () => {
    asAdmin();
    state.tables.post = { select: { single: { status: "draft" } }, mutate: { error: { message: "nope" } } };
    state.tables.post_video = {
      select: { rows: [{ id: "pv0", sort_order: 0, status: "ready", mux_upload_id: null, mux_asset_id: "as_0" }] },
    };
    const r = await DELETE(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(400);
    expect(cleanupMuxVideo).not.toHaveBeenCalled();
  });

  // ENG-1597 — a concurrent publish can win the race between the status check
  // above and the scoped delete: the delete's own `.eq("status","draft")`
  // matches nothing, so it comes back with NO error and ZERO rows. The post is
  // live now, so its (possibly video) Mux assets must survive — no cleanup,
  // and the caller is told the draft never was discarded.
  it("a concurrent publish wins the race (delete matches 0 rows, no error) → 409 not_a_draft, no Mux fetch/cleanup", async () => {
    asAdmin();
    state.tables.post = { select: { single: { status: "draft" } }, mutate: { rows: [] } };
    state.tables.post_video = {
      select: { rows: [{ id: "pv0", sort_order: 0, status: "ready", mux_upload_id: null, mux_asset_id: "as_0" }] },
    };
    const r = await DELETE(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error.code).toBe("not_a_draft");
    expect(cleanupMuxVideo).not.toHaveBeenCalled();
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
    // ENG-1268 — a `sourceTrainerId` in the body makes the route pre-read
    // `post.subject` (the trainer byline is horse-post-only), so this fixture
    // now needs a `select` script alongside the update's `mutate` one.
    state.tables.post = {
      select: { single: { subject: "horse" } },
      mutate: { single: { id: "p1", title: "New" } },
    };
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

describe("PATCH — subject & byline (ENG-1268)", () => {
  // NOTE (.rx/gotchas.md — "supabase-fake's .single() reads the table script
  // TWICE per call"): the route does up to TWO reads off `post` before the
  // update — the subject pre-read (`.select("subject")...maybeSingle()`) and
  // the final `.update(...).select("*").maybeSingle()`. These are TWO SEPARATE
  // `sb.from("post")` builders, so the first reads `state.tables.post.select`
  // (op stays "select" on that chain) and the second reads
  // `state.tables.post.mutate` (op flips to "mutate" once `.update()` is
  // called) — no getter/sequencing trick needed, just both sub-keys scripted
  // on the one table entry. `post_byline` is scripted as its own table entry.

  it("byline OK: a live post_byline name on a stablepass post → 200, update carries byline", async () => {
    asAdmin();
    state.tables.post = {
      select: { single: { subject: "stablepass" } },
      mutate: { single: { id: "p1", byline: "Racing TV" } },
    };
    state.tables.post_byline = { select: { single: { name: "Racing TV", retired_at: null } } };
    const r = await PATCH(patchReq({ byline: "Racing TV" }), ctx("p1"));
    expect(r.status).toBe(200);
    const updateCall = state.calls.mutations.find((m) => m.table === "post" && m.op === "update");
    expect(updateCall?.payload).toMatchObject({ byline: "Racing TV" });
  });

  it("byline naming a RETIRED post_byline row → 400 unknown_byline", async () => {
    asAdmin();
    state.tables.post = { select: { single: { subject: "stablepass" } } };
    state.tables.post_byline = {
      select: { single: { name: "Retired One", retired_at: "2026-09-01T00:00:00Z" } },
    };
    const r = await PATCH(patchReq({ byline: "Retired One" }), ctx("p1"));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("unknown_byline");
  });

  it("byline on a HORSE post → 400 validation_failed (byline is stablepass-only)", async () => {
    asAdmin();
    state.tables.post = { select: { single: { subject: "horse" } } };
    const r = await PATCH(patchReq({ byline: "Racing TV" }), ctx("p1"));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
  });

  it("subject in the body → 400 validation_failed (immutable), and NO update mutation was recorded", async () => {
    asAdmin();
    const r = await PATCH(patchReq({ subject: "horse" }), ctx("p1"));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
    expect(state.calls.mutations.some((m) => m.table === "post" && m.op === "update")).toBe(false);
  });

  it("horseId in the body → 400 validation_failed (immutable)", async () => {
    asAdmin();
    const r = await PATCH(patchReq({ horseId: "h2" }), ctx("p1"));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
  });

  it("sourceTrainerId on a TRAINER post → 400 validation_failed (the trainer post's trainer is immutable)", async () => {
    asAdmin();
    state.tables.post = { select: { single: { subject: "trainer" } } };
    const r = await PATCH(patchReq({ sourceTrainerId: "t9" }), ctx("p1"));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
  });

  it("sourceTrainerId on a HORSE post → 200 (the trainer byline is still editable)", async () => {
    asAdmin();
    state.tables.post = {
      select: { single: { subject: "horse" } },
      mutate: { single: { id: "p1", source_trainer_id: "t9" } },
    };
    const r = await PATCH(patchReq({ sourceTrainerId: "t9" }), ctx("p1"));
    expect(r.status).toBe(200);
  });
});

describe("PATCH — videos (ENG-1597)", () => {
  const A = "11111111-1111-1111-1111-111111111111";
  const B = "22222222-2222-2222-2222-222222222222";
  const C = "33333333-3333-3333-3333-333333333333";

  /** A video post whose current `post_video` rows are exactly `rows`. */
  function seedVideoPost(rows: { id: string; sort_order: number }[], opts?: { mutate?: boolean }) {
    state.tables.post = {
      select: { single: { id: "p1", type: "video" } },
      ...(opts?.mutate ? { mutate: { single: { id: "p1", type: "video" } } } : {}),
    };
    state.tables.post_video = {
      select: {
        rows: rows.map((r) => ({
          id: r.id,
          sort_order: r.sort_order,
          status: "ready",
          mux_upload_id: null,
          mux_asset_id: `as_${r.id}`,
        })),
      },
    };
  }

  function videoWrites() {
    return state.calls.mutations.filter((m) => m.table === "post_video");
  }

  it("reorder [C, A, B] → ONE upsert with that exact payload and onConflict 'id'; nothing deleted", async () => {
    asAdmin();
    seedVideoPost([
      { id: A, sort_order: 0 },
      { id: B, sort_order: 1 },
      { id: C, sort_order: 2 },
    ]);
    const r = await PATCH(patchReq({ videos: [C, A, B] }), ctx("p1"));
    expect(r.status).toBe(200);
    const upsert = videoWrites().find((m) => m.op === "upsert");
    expect(upsert?.payload).toEqual([
      { id: C, post_id: "p1", sort_order: 0 },
      { id: A, post_id: "p1", sort_order: 1 },
      { id: B, post_id: "p1", sort_order: 2 },
    ]);
    expect(upsert?.options).toEqual({ onConflict: "id" });
    expect(videoWrites().some((m) => m.op === "delete")).toBe(false);
    // The new slot 0 (C) is a genuinely new cover → its poster frame is cleared.
    expect(videoWrites()).toContainEqual(
      expect.objectContaining({
        op: "update",
        payload: { poster_time_s: null },
        filters: expect.arrayContaining([{ column: "id", value: C }]),
      }),
    );
  });

  it("removing B → delete filtered to [B] + post_id, then cleanup called with B's mux asset id", async () => {
    asAdmin();
    seedVideoPost([
      { id: A, sort_order: 0 },
      { id: B, sort_order: 1 },
    ]);
    const r = await PATCH(patchReq({ videos: [A] }), ctx("p1"));
    expect(r.status).toBe(200);
    const del = videoWrites().find((m) => m.op === "delete");
    expect(del?.filters).toEqual(
      expect.arrayContaining([
        { column: "id", value: [B], op: "in" },
        { column: "post_id", value: "p1" },
      ]),
    );
    expect(cleanupMuxVideo).toHaveBeenCalledWith({ videoId: B, assetId: `as_${B}`, uploadId: null });
    // Slot 0 (A) did not change → no poster clear and no reorder upsert.
    expect(videoWrites().some((m) => m.op === "upsert")).toBe(false);
  });

  it("slot-0 change clears poster_time_s on the new slot 0", async () => {
    asAdmin();
    seedVideoPost([
      { id: A, sort_order: 0 },
      { id: B, sort_order: 1 },
    ]);
    const r = await PATCH(patchReq({ videos: [B, A] }), ctx("p1"));
    expect(r.status).toBe(200);
    expect(videoWrites()).toContainEqual(
      expect.objectContaining({
        op: "update",
        payload: { poster_time_s: null },
        filters: expect.arrayContaining([{ column: "id", value: B }]),
      }),
    );
  });

  it("unchanged slot 0 → no poster clear, even though the tail reorders", async () => {
    asAdmin();
    seedVideoPost([
      { id: A, sort_order: 0 },
      { id: B, sort_order: 1 },
      { id: C, sort_order: 2 },
    ]);
    const r = await PATCH(patchReq({ videos: [A, C, B] }), ctx("p1"));
    expect(r.status).toBe(200);
    const upsert = videoWrites().find((m) => m.op === "upsert");
    expect(upsert).toBeTruthy(); // B/C still swap
    expect(
      videoWrites().some((m) => m.op === "update" && m.payload?.poster_time_s === null),
    ).toBe(false);
  });

  const D = "44444444-4444-4444-4444-444444444444";
  const E = "55555555-5555-5555-5555-555555555555";
  const F = "66666666-6666-6666-6666-666666666666";

  it.each([
    ["empty", []],
    ["a duplicate", [A, A]],
    ["a non-uuid", [A, "not-a-uuid"]],
    ["6 ids", [A, B, C, D, E, F]],
  ])("videos = %s → 400 invalid_video_set, no post_video write", async (_label, videos) => {
    asAdmin();
    seedVideoPost([
      { id: A, sort_order: 0 },
      { id: B, sort_order: 1 },
      { id: C, sort_order: 2 },
    ]);
    const r = await PATCH(patchReq({ videos }), ctx("p1"));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("invalid_video_set");
    expect(videoWrites()).toHaveLength(0);
  });

  it("an id not among the post's current rows → 400 invalid_video_set, no writes", async () => {
    asAdmin();
    seedVideoPost([{ id: A, sort_order: 0 }]);
    const r = await PATCH(patchReq({ videos: [A, B] }), ctx("p1"));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("invalid_video_set");
    expect(videoWrites()).toHaveLength(0);
  });

  it("knownVideos mismatch → 409 video_set_stale, no writes", async () => {
    asAdmin();
    seedVideoPost([
      { id: A, sort_order: 0 },
      { id: B, sort_order: 1 },
    ]);
    const r = await PATCH(patchReq({ videos: [B, A], knownVideos: [A] }), ctx("p1"));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error.code).toBe("video_set_stale");
    expect(videoWrites()).toHaveLength(0);
  });

  it("videos on a non-video post → 409 not_video_post", async () => {
    asAdmin();
    state.tables.post = { select: { single: { id: "p1", type: "photo" } } };
    const r = await PATCH(patchReq({ videos: [A] }), ctx("p1"));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error.code).toBe("not_video_post");
  });

  it("poster_time_s on a video post also updates the slot-0 post_video row", async () => {
    asAdmin();
    seedVideoPost([{ id: A, sort_order: 0 }], { mutate: true });
    const r = await PATCH(patchReq({ poster_time_s: 4.2 }), ctx("p1"));
    expect(r.status).toBe(200);
    expect(videoWrites()).toContainEqual(
      expect.objectContaining({
        op: "update",
        payload: { poster_time_s: 4.2 },
        filters: expect.arrayContaining([{ column: "id", value: A }]),
      }),
    );
    // ...and the ordinary `post` column write still happened, unchanged.
    const postUpdate = state.calls.mutations.find((m) => m.table === "post" && m.op === "update");
    expect(postUpdate?.payload).toMatchObject({ poster_time_s: 4.2 });
  });

  it("poster_time_s on a NON-video post does not touch post_video at all", async () => {
    asAdmin();
    state.tables.post = {
      select: { single: { id: "p1", type: "photo" } },
      mutate: { single: { id: "p1" } },
    };
    const r = await PATCH(patchReq({ poster_time_s: 4.2 }), ctx("p1"));
    expect(r.status).toBe(200);
    expect(videoWrites()).toHaveLength(0);
  });

  it("a Mux cleanup failure never turns a successful save into a non-200", async () => {
    asAdmin();
    seedVideoPost([
      { id: A, sort_order: 0 },
      { id: B, sort_order: 1 },
    ]);
    // Actually simulate the failure this test claims to guard against — the
    // mocked `cleanupMuxVideo` REJECTS, same as a real Mux 500 would surface
    // before its own internal swallow. The wrapper above (not this bare spy)
    // is what has to catch it, exactly like the real implementation does —
    // a spy that merely resolves (the old version of this test) proves nothing.
    cleanupMuxVideo.mockRejectedValueOnce(new Error("mux down"));
    const r = await PATCH(patchReq({ videos: [A] }), ctx("p1"));
    expect(r.status).toBe(200);
  });

  it("videos-only request skips the post-table UPDATE and reads the row instead", async () => {
    asAdmin();
    seedVideoPost([
      { id: A, sort_order: 0 },
      { id: B, sort_order: 1 },
    ]);
    const r = await PATCH(patchReq({ videos: [B, A] }), ctx("p1"));
    expect(r.status).toBe(200);
    expect(state.calls.mutations.some((m) => m.table === "post" && m.op === "update")).toBe(false);
  });

  // ENG-1597 — a reorder failure must not strand a removal that already
  // committed: the delete for B runs and its Mux cleanup fires BEFORE the
  // reorder upsert is even attempted, so a failure in the upsert cannot undo
  // (or hide) the cleanup that already happened.
  it("remove + reorder where the reorder upsert fails → 400, but the removed row's Mux cleanup already happened", async () => {
    asAdmin();
    state.tables.post = { select: { single: { id: "p1", type: "video" } } };
    let reads = 0;
    Object.defineProperty(state.tables, "post_video", {
      configurable: true,
      get() {
        reads += 1;
        if (reads === 1)
          return {
            select: {
              rows: [
                { id: A, sort_order: 0, status: "ready", mux_upload_id: null, mux_asset_id: `as_${A}` },
                { id: B, sort_order: 1, status: "ready", mux_upload_id: null, mux_asset_id: `as_${B}` },
                { id: C, sort_order: 2, status: "ready", mux_upload_id: null, mux_asset_id: `as_${C}` },
              ],
            },
          };
        if (reads === 2) return { mutate: {} }; // the removal delete (B) succeeds
        return { mutate: { error: { code: "XX000", message: "internal error" } } }; // the reorder upsert fails
      },
    });
    const r = await PATCH(patchReq({ videos: [A, C] }), ctx("p1"));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("update_failed");
    expect(cleanupMuxVideo).toHaveBeenCalledWith({ videoId: B, assetId: `as_${B}`, uploadId: null });
  });

  it("reorder upsert error 23505 → 409 video_set_stale", async () => {
    asAdmin();
    seedVideoPost([
      { id: A, sort_order: 0 },
      { id: B, sort_order: 1 },
    ]);
    state.tables.post_video = {
      ...state.tables.post_video,
      mutate: { error: { code: "23505", message: "duplicate key value violates unique constraint" } },
    };
    const r = await PATCH(patchReq({ videos: [B, A] }), ctx("p1"));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error.code).toBe("video_set_stale");
  });

  it("removal delete error → 400 update_failed, no upsert attempted", async () => {
    asAdmin();
    seedVideoPost([
      { id: A, sort_order: 0 },
      { id: B, sort_order: 1 },
    ]);
    state.tables.post_video = {
      ...state.tables.post_video,
      mutate: { error: { code: "XX000", message: "internal error" } },
    };
    const r = await PATCH(patchReq({ videos: [A] }), ctx("p1"));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("update_failed");
    expect(videoWrites().some((m) => m.op === "upsert")).toBe(false);
    expect(cleanupMuxVideo).not.toHaveBeenCalled();
  });

  // ENG-1597 — the upsert is INSERT ... ON CONFLICT: if a racing request
  // deleted B after this route's own read, B comes back from the upsert as a
  // GHOST — a re-inserted row with a new `created_at`. The route must catch
  // that, delete the ghost, and 409 rather than silently reordering a set the
  // operator never saw.
  it("a ghost re-insert after the reorder upsert → 409 video_set_stale, and a delete scoped to the ghost id + post_id", async () => {
    asAdmin();
    state.tables.post = { select: { single: { id: "p1", type: "video" } } };
    const loadedAt = "2026-01-01T00:00:00Z";
    let reads = 0;
    Object.defineProperty(state.tables, "post_video", {
      configurable: true,
      get() {
        reads += 1;
        if (reads === 1)
          return {
            select: {
              rows: [
                { id: A, sort_order: 0, status: "ready", mux_upload_id: null, mux_asset_id: `as_${A}`, created_at: loadedAt },
                { id: B, sort_order: 1, status: "ready", mux_upload_id: null, mux_asset_id: `as_${B}`, created_at: loadedAt },
              ],
            },
          };
        if (reads === 2)
          return {
            mutate: {
              rows: [
                { id: A, created_at: loadedAt },
                { id: B, created_at: "2026-02-02T00:00:00Z" }, // ghost — re-created, different created_at
              ],
            },
          };
        return { mutate: {} }; // the ghost-cleanup delete
      },
    });
    const r = await PATCH(patchReq({ videos: [B, A] }), ctx("p1"));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error.code).toBe("video_set_stale");
    const ghostDelete = videoWrites().find((m) => m.op === "delete");
    expect(ghostDelete?.filters).toEqual(
      expect.arrayContaining([
        { column: "id", value: [B], op: "in" },
        { column: "post_id", value: "p1" },
      ]),
    );
  });

  // ENG-1597 — a LIVE post's cover must be playable: moving a still-uploading
  // row into slot 0 would blank the video for every reader of `post`.
  it("moving an UPLOADING row into slot 0 on a PUBLISHED post → 409 videos_not_ready, no writes", async () => {
    asAdmin();
    state.tables.post = { select: { single: { id: "p1", type: "video", status: "published" } } };
    state.tables.post_video = {
      select: {
        rows: [
          { id: A, sort_order: 0, status: "ready", mux_upload_id: null, mux_asset_id: `as_${A}` },
          { id: B, sort_order: 1, status: "uploading", mux_upload_id: "up_B", mux_asset_id: null },
        ],
      },
    };
    const r = await PATCH(patchReq({ videos: [B, A] }), ctx("p1"));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error.code).toBe("videos_not_ready");
    expect(j.error.notReady).toEqual([B]);
    expect(videoWrites()).toHaveLength(0);
    expect(state.calls.mutations.some((m) => m.table === "post")).toBe(false);
  });

  it("the same move on a DRAFT post → 200 (a draft's cover need not be ready yet)", async () => {
    asAdmin();
    state.tables.post = { select: { single: { id: "p1", type: "video", status: "draft" } } };
    state.tables.post_video = {
      select: {
        rows: [
          { id: A, sort_order: 0, status: "ready", mux_upload_id: null, mux_asset_id: `as_${A}` },
          { id: B, sort_order: 1, status: "uploading", mux_upload_id: "up_B", mux_asset_id: null },
        ],
      },
      mutate: {},
    };
    const r = await PATCH(patchReq({ videos: [B, A] }), ctx("p1"));
    expect(r.status).toBe(200);
  });
});
