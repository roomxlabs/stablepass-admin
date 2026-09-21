import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));

import { POST } from "./route";

// A well-formed uuid — the route 404s a non-uuid id before it ever queries
// the post, so every test that means to reach that query needs a real one.
const P1 = "11111111-1111-1111-1111-111111111111";

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}
function asNonAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: false } } };
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const postReq = (body?: unknown) =>
  new Request("http://t", {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** A photo post, with its `post_media` rows and (by default) an empty Storage listing. */
function seedPhotoPost(opts: {
  id?: string;
  mediaUrl?: string | null;
  rows?: { media_url: string }[];
  objects?: { name: string }[];
}) {
  const id = opts.id ?? P1;
  state.tables.post = {
    select: { single: { id, type: "photo", media_url: opts.mediaUrl ?? `${P1}/original` } },
  };
  state.tables.post_media = { select: { rows: opts.rows ?? [] } };
  if (opts.objects) state.storage.list = { data: opts.objects, error: null };
}

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("POST /api/admin/posts/:id/photo-uploads — ENG-1266", () => {
  it("403s for a non-admin (guardrail) — nothing queried, nothing signed", async () => {
    asNonAdmin();
    const r = await POST(postReq({ count: 1 }), ctx(P1));
    expect(r.status).toBe(403);
    expect(state.calls.mutations).toHaveLength(0);
    expect(state.calls.storage).toHaveLength(0);
    expect(state.calls.storageList).toHaveLength(0);
  });

  it("200 happy path: mints the NEXT slots after the post's existing post_media rows", async () => {
    asAdmin();
    seedPhotoPost({
      rows: [{ media_url: `${P1}/original` }, { media_url: `${P1}/photo-1` }],
    });

    const r = await POST(postReq({ count: 2 }), ctx(P1));
    expect(r.status).toBe(200);
    const j = await r.json();

    // The response envelope shape: { data: { uploads: [...] } }.
    expect(j).toEqual({
      data: {
        uploads: [
          {
            sortOrder: 2,
            path: `${P1}/photo-2`,
            token: "tok",
            uploadUrl: `https://storage.local/post-media/${P1}/photo-2`,
            bucket: "post-media",
          },
          {
            sortOrder: 3,
            path: `${P1}/photo-3`,
            token: "tok",
            uploadUrl: `https://storage.local/post-media/${P1}/photo-3`,
            bucket: "post-media",
          },
        ],
      },
    });

    // The signed paths, in order — pinned EXACTLY so the slot derivation
    // itself is proven, not merely "some signing happened".
    expect(state.calls.storage).toEqual([
      { bucket: "post-media", path: `${P1}/photo-2` },
      { bucket: "post-media", path: `${P1}/photo-3` },
    ]);
  });

  it("numbers the next slot after a GAP in post_media (original, photo-1, photo-4 → photo-5)", async () => {
    asAdmin();
    seedPhotoPost({
      rows: [
        { media_url: `${P1}/original` },
        { media_url: `${P1}/photo-1` },
        { media_url: `${P1}/photo-4` },
      ],
    });

    const r = await POST(postReq({ count: 1 }), ctx(P1));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.uploads).toEqual([
      {
        sortOrder: 5,
        path: `${P1}/photo-5`,
        token: "tok",
        uploadUrl: `https://storage.local/post-media/${P1}/photo-5`,
        bucket: "post-media",
      },
    ]);
  });

  it("409 not_photo_post for a video post", async () => {
    asAdmin();
    state.tables.post = { select: { single: { id: P1, type: "video", media_url: null } } };
    const r = await POST(postReq({ count: 1 }), ctx(P1));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error.code).toBe("not_photo_post");
    expect(state.calls.storage).toHaveLength(0);
  });

  it.each([
    ["zero", 0],
    ["over the cap", 11],
    ["a fraction", 1.5],
    ["a numeric STRING", "2"],
  ])("400 validation_failed for count = %s (%j) — before the post is even queried", async (_label, count) => {
    asAdmin();
    const r = await POST(postReq({ count }), ctx(P1));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
    // Validated before any query — a bad count must not reach the post table.
    expect(state.calls.from).not.toContain("post");
    expect(state.calls.storage).toHaveLength(0);
  });

  it("400 validation_failed when the body is missing entirely", async () => {
    asAdmin();
    const r = await POST(postReq(undefined), ctx(P1));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
    expect(state.calls.from).not.toContain("post");
  });

  it("400 too_many_photos when 9 already exist and 2 more are requested", async () => {
    asAdmin();
    const rows = Array.from({ length: 9 }, (_, i) => ({
      media_url: i === 0 ? `${P1}/original` : `${P1}/photo-${i}`,
    }));
    seedPhotoPost({ rows });

    const r = await POST(postReq({ count: 2 }), ctx(P1));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("too_many_photos");
    expect(j.error.message).toContain("up to 10 photos");
    expect(j.error.message).toContain("this would make 11");
    expect(state.calls.storage).toHaveLength(0);
  });

  it("404 not_found for an unknown post", async () => {
    asAdmin();
    state.tables.post = { select: { single: null } };
    const r = await POST(postReq({ count: 1 }), ctx(P1));
    expect(r.status).toBe(404);
    const j = await r.json();
    expect(j.error.code).toBe("not_found");
  });

  it("404 not_found for a non-uuid id — and NO post query is even attempted", async () => {
    asAdmin();
    const r = await POST(postReq({ count: 1 }), ctx("not-a-uuid"));
    expect(r.status).toBe(404);
    const j = await r.json();
    expect(j.error.code).toBe("not_found");
    // The uuid shape-check runs before the post is ever queried — a malformed
    // id must not reach Postgres and echo an "invalid input syntax" leak.
    expect(state.calls.from).not.toContain("post");
  });

  it("502 storage_unavailable when signing fails — nothing partial is returned", async () => {
    asAdmin();
    seedPhotoPost({ rows: [{ media_url: `${P1}/original` }] });
    state.storage.signed = { data: null, error: { message: "Storage is down" } };

    const r = await POST(postReq({ count: 1 }), ctx(P1));
    expect(r.status).toBe(502);
    const j = await r.json();
    expect(j.error.code).toBe("storage_unavailable");
    expect(j.error.message).toBe("Storage is down");
  });

  // The route's OWN reason for reading Storage rather than only `post_media`:
  // a draft's strip already holds bytes that no `post_media` row mirrors yet.
  describe("Storage listing keeps a create-mode append safe (the route's own reason for it)", () => {
    it("post_media EMPTY (a draft) + a Storage listing of original/photo-1/photo-2 → next is photo-3, NOT photo-1", async () => {
      asAdmin();
      seedPhotoPost({
        rows: [],
        objects: [{ name: "original" }, { name: "photo-1" }, { name: "photo-2" }],
      });

      const r = await POST(postReq({ count: 1 }), ctx(P1));
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j.data.uploads).toEqual([
        {
          sortOrder: 3,
          path: `${P1}/photo-3`,
          token: "tok",
          uploadUrl: `https://storage.local/post-media/${P1}/photo-3`,
          bucket: "post-media",
        },
      ]);

      // The listing call is recorded, but on its OWN array — it must not
      // corrupt the exact-order assertion available against calls.storage
      // (the signed-upload targets) elsewhere in this file.
      //
      // `{ limit: 1000 }`, not the Storage SDK's default of 100: the default
      // is also LEXICOGRAPHIC (`photo-1, photo-10, photo-100, …, photo-2`),
      // and orphaned objects are never cleaned up, so a long-lived post can
      // exceed 100 objects — past which the listing would silently truncate
      // and the slot floor derived from it could regress onto a slot that
      // already holds bytes.
      expect(state.calls.storageList).toEqual([
        { bucket: "post-media", path: P1, options: { limit: 1000 } },
      ]);
      expect(state.calls.storage).toEqual([{ bucket: "post-media", path: `${P1}/photo-3` }]);
    });

    it("the cap is checked against whichever view sees MORE photos (Storage, here)", async () => {
      asAdmin();
      // Only 2 post_media rows, but 9 objects already sitting in Storage — the
      // draft-in-progress case the comment on the route describes.
      seedPhotoPost({
        rows: [{ media_url: `${P1}/original` }, { media_url: `${P1}/photo-1` }],
        objects: Array.from({ length: 9 }, (_, i) => ({ name: i === 0 ? "original" : `photo-${i}` })),
      });

      const r = await POST(postReq({ count: 2 }), ctx(P1));
      expect(r.status).toBe(400);
      const j = await r.json();
      expect(j.error.code).toBe("too_many_photos");
      expect(state.calls.storage).toHaveLength(0);
    });
  });

  // --- F1 regression: `afterSlot`, the browser's highest HELD ordinal -------
  describe("afterSlot — the fix for the mid-upload slot collision (F1)", () => {
    it("pushes the start forward past the server's own view: original held + an in-flight photo-4 the server cannot see yet → photo-5", async () => {
      asAdmin();
      seedPhotoPost({
        rows: [{ media_url: `${P1}/original` }],
        objects: [{ name: "original" }],
      });

      // The server's own derivation would answer photo-1 here (it only knows
      // about `original`) — `afterSlot: 4` is the strip telling it a slot it
      // cannot see is still live.
      const r = await POST(postReq({ count: 1, afterSlot: 4 }), ctx(P1));
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j.data.uploads).toEqual([
        {
          sortOrder: 5,
          path: `${P1}/photo-5`,
          token: "tok",
          uploadUrl: `https://storage.local/post-media/${P1}/photo-5`,
          bucket: "post-media",
        },
      ]);
      expect(state.calls.storage).toEqual([{ bucket: "post-media", path: `${P1}/photo-5` }]);
    });

    it("a stale/low hint cannot re-issue a slot the server's own view already holds — the server floor wins", async () => {
      asAdmin();
      seedPhotoPost({
        rows: [],
        objects: [{ name: "original" }, { name: "photo-1" }, { name: "photo-2" }],
      });

      // afterSlot: 0 claims nothing is held past slot 0 — wrong, and either
      // stale or hostile. The server's own derivation (photo-3) must still win.
      const r = await POST(postReq({ count: 1, afterSlot: 0 }), ctx(P1));
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j.data.uploads[0].path).toBe(`${P1}/photo-3`);
    });

    it.each([
      ["negative", -1],
      ["over MAX_SLOT_HINT", 1000],
      ["a fraction", 2.5],
      ["a numeric STRING", "3"],
    ])(
      "an invalid afterSlot (%s: %j) is ignored, NOT rejected — falls back to the server's own derivation",
      async (_label, afterSlot) => {
        asAdmin();
        // Server's own derivation from `original` alone is photo-1.
        seedPhotoPost({ rows: [{ media_url: `${P1}/original` }] });

        const r = await POST(postReq({ count: 1, afterSlot }), ctx(P1));
        expect(r.status).toBe(200);
        const j = await r.json();
        expect(j.data.uploads[0].path).toBe(`${P1}/photo-1`);
      },
    );

    it("a hostile-but-in-range hint (999) on an empty post is bounded — mints photo-1000, not something absurd", async () => {
      asAdmin();
      seedPhotoPost({ rows: [] });

      const r = await POST(postReq({ count: 1, afterSlot: 999 }), ctx(P1));
      expect(r.status).toBe(200);
      const j = await r.json();
      // Exactly photo-1000 (999 + 1) — MAX_SLOT_HINT is the ceiling on the
      // HINT, not on the slot it can produce, but nothing wilder reaches it.
      expect(j.data.uploads[0].path).toBe(`${P1}/photo-1000`);
      expect(j.data.uploads[0].path).not.toMatch(/photo-999999/);
    });
  });

  // --- F5 regression: `keeping` counts what the operator will KEEP ----------
  describe("keeping — the cap counts kept photos, not orphaned objects (F5)", () => {
    function seedFullPost() {
      const rows = Array.from({ length: 10 }, (_, i) => ({
        media_url: i === 0 ? `${P1}/original` : `${P1}/photo-${i}`,
      }));
      const objects = rows.map((r) => ({ name: r.media_url.split("/").pop()! }));
      seedPhotoPost({ rows, objects });
    }

    it("200: a full 10-photo post replacing one (keeping: 9) + 1 more fits, even though 10 objects still exist", async () => {
      asAdmin();
      seedFullPost();

      const r = await POST(postReq({ count: 1, keeping: 9 }), ctx(P1));
      expect(r.status).toBe(200);
    });

    it("400 too_many_photos: keeping the full 10 + 1 more does not fit", async () => {
      asAdmin();
      seedFullPost();

      const r = await POST(postReq({ count: 1, keeping: 10 }), ctx(P1));
      expect(r.status).toBe(400);
      const j = await r.json();
      expect(j.error.code).toBe("too_many_photos");
    });

    it.each([
      ["absent", undefined],
      ["negative", -1],
      ["over MAX_PHOTOS", 11],
      ["a fraction", 2.5],
      ["a numeric STRING", "9"],
    ])(
      "an invalid keeping (%s: %j) is ignored — falls back to the object/row count, so a full post still 400s",
      async (_label, keeping) => {
        asAdmin();
        seedFullPost();

        const r = await POST(postReq({ count: 1, keeping }), ctx(P1));
        expect(r.status).toBe(400);
        const j = await r.json();
        expect(j.error.code).toBe("too_many_photos");
      },
    );
  });

  // --- F4 regression: fail closed on the Storage listing --------------------
  describe("Storage listing failure fails CLOSED (F4)", () => {
    it("502 storage_unavailable when list() errors — no signed-upload call happens", async () => {
      asAdmin();
      seedPhotoPost({ rows: [{ media_url: `${P1}/original` }] });
      state.storage.list = { data: null, error: { message: "Storage listing is down" } };

      const r = await POST(postReq({ count: 1 }), ctx(P1));
      expect(r.status).toBe(502);
      const j = await r.json();
      expect(j.error.code).toBe("storage_unavailable");
      expect(j.error.message).toBe("Storage listing is down");
      // The whole point: no upload target was signed off a listing we know is
      // wrong (or unknowable) — no silent post_media-only degrade.
      expect(state.calls.storage).toHaveLength(0);
      expect(state.calls.storageList).toEqual([
        { bucket: "post-media", path: P1, options: { limit: 1000 } },
      ]);
    });
  });

  // --- F6 regression: the guardrail gaps the route's own tests missed -------
  describe("guardrail (F6): the two cases the route's own tests were missing", () => {
    it("401s with no session — nothing queried, nothing signed", async () => {
      // No asAdmin()/asNonAdmin() call: state.user stays null (blankState's
      // default), i.e. no session at all.
      const r = await POST(postReq({ count: 1 }), ctx(P1));
      expect(r.status).toBe(401);
      expect(state.calls.storage).toHaveLength(0);
      expect(state.calls.storageList).toHaveLength(0);
    });

    it("403 mfa_required for an admin whose session is only AAL1 — nothing queried, nothing signed", async () => {
      asAdmin();
      state.aal = "aal1";
      const r = await POST(postReq({ count: 1 }), ctx(P1));
      expect(r.status).toBe(403);
      const j = await r.json();
      expect(j.error.code).toBe("mfa_required");
      expect(state.calls.storage).toHaveLength(0);
      expect(state.calls.storageList).toHaveLength(0);
    });
  });
});
