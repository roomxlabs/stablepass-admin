import { describe, it, expect, beforeEach, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";
import type { MuxListedAsset } from "@/lib/mux";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));
const findMuxAssetByPassthrough = vi.fn(async () => null as { assetId: string; playbackId: string } | null);
// ENG-1609 — `readPostVideoStatus` → `reconcilePostVideos` lists Mux assets via
// `listReadyMuxAssets` (never a real Mux fetch); scripted per-test like
// `findMuxAssetByPassthrough` already is.
const listReadyMuxAssets = vi.fn(async () => [] as MuxListedAsset[]);
vi.mock("@/lib/mux", () => ({
  findMuxAssetByPassthrough: () => findMuxAssetByPassthrough(),
  listReadyMuxAssets: () => listReadyMuxAssets(),
}));

import { GET } from "./route";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.MUX_SIGNING_KEY_ID = "sk_test";
process.env.MUX_SIGNING_PRIVATE_KEY = Buffer.from(
  privateKey.export({ type: "pkcs1", format: "pem" }),
).toString("base64");

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}
const req = () => new Request("http://t/api/admin/posts/p1/preview");
const params = { params: Promise.resolve({ id: "p1" }) };

beforeEach(() => {
  Object.assign(state, blankState());
  findMuxAssetByPassthrough.mockReset();
  findMuxAssetByPassthrough.mockResolvedValue(null);
  listReadyMuxAssets.mockReset();
  listReadyMuxAssets.mockResolvedValue([]);
});

describe("GET /api/admin/posts/:id/preview", () => {
  it("403s for a non-admin (guardrail)", async () => {
    state.user = { id: "u1" };
    state.tables.app_user = { select: { single: { is_admin: false } } };
    const r = await GET(req(), params);
    expect(r.status).toBe(403);
  });

  it("404s when the post does not exist", async () => {
    asAdmin();
    state.tables.post = { select: { single: null } };
    const r = await GET(req(), params);
    expect(r.status).toBe(404);
  });

  it("video with a reconciled playback id → frames carry a signed HLS playbackUrl", async () => {
    asAdmin();
    state.tables.post = {
      select: { single: { id: "p1", type: "video", status: "published", mux_playback_id: "pb_1" } },
    };
    // ENG-1609 — the post_video table now backs this read too; a fully
    // reconciled row must not trigger any write.
    state.tables.post_video = {
      select: {
        rows: [
          {
            id: "v1",
            sort_order: 0,
            status: "ready",
            mux_upload_id: "up_1",
            mux_playback_id: "pb_1",
            poster_url: null,
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      },
    };
    const r = await GET(req(), params);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.mobile.muxPlaybackId).toBe("pb_1");
    expect(j.data.mobile.playbackUrl).toContain("https://stream.mux.com/pb_1.m3u8?token=");
    expect(j.data.web.playbackUrl).toBe(j.data.mobile.playbackUrl);
    expect(state.calls.mutations).toEqual([]);
  });

  it("pre-migration (no post_video table): falls back to the Mux passthrough lookup", async () => {
    asAdmin();
    findMuxAssetByPassthrough.mockResolvedValue({ assetId: "as_1", playbackId: "pb_2" });
    state.tables.post = {
      select: { single: { id: "p1", type: "video", status: "draft", mux_playback_id: null } },
      mutate: {}, // the guarded reconcile UPDATE
    };
    // ENG-1609 — `post_video` does not exist yet on this environment; the
    // route must fall back to the old post-level passthrough lookup.
    state.tables.post_video = {
      select: { error: { code: "42P01", message: "relation post_video does not exist" } },
    };
    const r = await GET(req(), params);
    const j = await r.json();
    expect(j.data.mobile.muxPlaybackId).toBe("pb_2");
    expect(j.data.mobile.playbackUrl).toContain("pb_2.m3u8?token=");
  });

  // ENG-993. The test above proves the reconcile *happens*; this proves it is
  // still CONDITIONAL. `lib/mux-playback.ts:99` guards its write with
  // `.is("mux_playback_id", null)` so it cannot clobber a playback id the Mux
  // webhook wrote in between (a lost update). Reached through the SHARED fake
  // — this route passes the real `sb`, so it is the only production path where
  // the shared fake sees that guard. While `is` was a `() => b` no-op the
  // filter was invisible here and the guard was pinned by nothing.
  it("pre-migration (no post_video table): the reconcile UPDATE carries its lost-update guard, not just an id match", async () => {
    asAdmin();
    findMuxAssetByPassthrough.mockResolvedValue({ assetId: "as_1", playbackId: "pb_2" });
    state.tables.post = {
      select: { single: { id: "p1", type: "video", status: "draft", mux_playback_id: null } },
      mutate: {},
    };
    state.tables.post_video = {
      select: { error: { code: "42P01", message: "relation post_video does not exist" } },
    };
    const r = await GET(req(), params);
    expect(r.status).toBe(200);

    const update = state.calls.mutations.find((m) => m.op === "update");
    expect(update).toBeDefined();
    expect(update!.table).toBe("post");
    expect(update!.filters).toEqual([
      { column: "id", value: "p1" },
      { column: "mux_playback_id", value: null, op: "is" },
    ]);
  });

  it("photo posts carry no playbackUrl", async () => {
    asAdmin();
    state.tables.post = {
      select: { single: { id: "p1", type: "photo", status: "published", media_url: "p1/original" } },
    };
    const r = await GET(req(), params);
    const j = await r.json();
    expect(j.data.mobile.playbackUrl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ENG-1269 — the `subject`/`subjectName`/`subjectTag`/`subjectDetail`/
// `subjectText` fields, one case per subject, plus proof that `horseName` and
// `byline` still behave exactly as before (back-compat for whatever already
// reads them) and that a null horse/trainer embed does not crash a
// trainer/StablePass post.
// ---------------------------------------------------------------------------
describe("GET /api/admin/posts/:id/preview — subject (ENG-1269)", () => {
  it("horse post: subject block names the horse, byline/horseName stay back-compat", async () => {
    asAdmin();
    state.tables.post = {
      select: {
        single: {
          id: "p1",
          subject: "horse",
          byline: null,
          type: "photo",
          status: "published",
          horse: { id: "h1", display_name: "Mahogany", racing_name: "MAHOGANY (AUS)" },
          trainer: { id: "t1", name: "Chris Waller" },
        },
      },
    };
    const r = await GET(req(), params);
    const j = await r.json();
    expect(j.data.mobile.subject).toBe("horse");
    expect(j.data.mobile.subjectName).toBe("MAHOGANY (AUS)");
    expect(j.data.mobile.subjectTag).toBeNull();
    expect(j.data.mobile.subjectDetail).toBe("Chris Waller");
    expect(j.data.mobile.subjectText).toBe("MAHOGANY (AUS)");
    // Back-compat fields, unchanged by this ticket.
    expect(j.data.mobile.horseName).toBe("MAHOGANY (AUS)");
    expect(j.data.mobile.byline).toBe("Chris Waller");
  });

  it("trainer post: subject block tags 'Trainer'; no horse embed to crash on", async () => {
    asAdmin();
    state.tables.post = {
      select: {
        single: {
          id: "p2",
          subject: "trainer",
          byline: null,
          type: "video",
          status: "published",
          horse: null,
          trainer: { id: "t1", name: "Chris Waller" },
        },
      },
    };
    const r = await GET(req(), params);
    const j = await r.json();
    expect(j.data.mobile.subject).toBe("trainer");
    expect(j.data.mobile.subjectName).toBe("Chris Waller");
    expect(j.data.mobile.subjectTag).toBe("Trainer");
    expect(j.data.mobile.subjectDetail).toBeNull();
    expect(j.data.mobile.subjectText).toBe("Chris Waller · Trainer");
    // `horseName` is honestly null — there is no horse to name.
    expect(j.data.mobile.horseName).toBeNull();
    expect(j.data.mobile.byline).toBe("Chris Waller");
  });

  it("stablepass post: subject block names the byline; no horse or trainer embed to crash on", async () => {
    asAdmin();
    state.tables.post = {
      select: {
        single: {
          id: "p3",
          subject: "stablepass",
          byline: "Racing TV",
          type: "photo",
          status: "published",
          horse: null,
          trainer: null,
        },
      },
    };
    const r = await GET(req(), params);
    const j = await r.json();
    expect(j.data.mobile.subject).toBe("stablepass");
    expect(j.data.mobile.subjectName).toBe("stablepass");
    expect(j.data.mobile.subjectTag).toBeNull();
    expect(j.data.mobile.subjectDetail).toBe("Racing TV");
    expect(j.data.mobile.subjectText).toBe("stablepass · Racing TV");
    // No trainer at all — the back-compat `byline` field is honestly null.
    expect(j.data.mobile.horseName).toBeNull();
    expect(j.data.mobile.byline).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ENG-1609 — the route reads video status through `readPostVideoStatus`
// (`lib/posts/video-status.ts`, `{ reconcile: true }`), which reconciles onto
// the `post_video` ROW rather than `post`. These prove the three result
// shapes it can return: a normal reconciled/unreconciled row set, the
// pre-migration "table missing" fallback (covered above), and a genuine
// `post_video` read error.
// ---------------------------------------------------------------------------
describe("GET /api/admin/posts/:id/preview — post_video reconcile (ENG-1609)", () => {
  it("legacy post whose slot-0 row is NULL: writes the post_video row (ready), never post", async () => {
    asAdmin();
    state.tables.post = {
      select: {
        single: {
          id: "p1",
          type: "video",
          status: "draft",
          mux_playback_id: null,
          mux_asset_id: null,
          poster_url: "posters/p1.jpg",
          poster_time_s: 3,
          aspect_ratio: 0.5625,
        },
      },
    };
    state.tables.post_video = {
      select: {
        rows: [
          {
            id: "v1",
            sort_order: 0,
            status: "uploading",
            mux_upload_id: null,
            mux_playback_id: null,
            poster_url: null,
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      },
      mutate: { rows: [{ id: "v1" }] },
    };
    listReadyMuxAssets.mockResolvedValue([
      { assetId: "as_1", playbackId: "pb_2", passthrough: "p1", aspectRatio: null },
    ]);

    const r = await GET(req(), params);
    expect(r.status).toBe(200);
    const j = await r.json();
    // `?? ""` keeps this a clean string-comparison failure (not a `toContain`
    // argument-type error) when the route hasn't reconciled yet.
    expect(j.data.mobile.playbackUrl ?? "").toContain("pb_2.m3u8?token=");

    const updates = state.calls.mutations.filter((m) => m.op === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe("post_video");
    // ENG-1611 "post wins": the slot-0 legacy row keeps the post's own poster + aspect,
    // so the mirror cannot blank them when it copies this row back onto `post`.
    expect(updates[0].payload).toMatchObject({
      status: "ready",
      mux_playback_id: "pb_2",
      poster_url: "posters/p1.jpg",
      poster_time_s: 3,
      aspect_ratio: 0.5625,
    });
    expect(updates[0].filters).toEqual([
      { column: "id", value: "v1" },
      { column: "mux_playback_id", value: null, op: "is" },
    ]);

    expect(state.calls.mutations.filter((m) => m.table === "post")).toHaveLength(0);
    expect(findMuxAssetByPassthrough).not.toHaveBeenCalled();
  });

  it("legacy post where post already holds the video: copies it down onto the row, no Mux call", async () => {
    asAdmin();
    state.tables.post = {
      select: {
        single: {
          id: "p1",
          type: "video",
          status: "draft",
          mux_playback_id: "pb_old",
          mux_asset_id: "as_old",
          poster_url: null,
          poster_time_s: null,
          aspect_ratio: null,
        },
      },
    };
    state.tables.post_video = {
      select: {
        rows: [
          {
            id: "v1",
            sort_order: 0,
            status: "uploading",
            mux_upload_id: null,
            mux_playback_id: null,
            poster_url: null,
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      },
      mutate: { rows: [{ id: "v1" }] },
    };

    const r = await GET(req(), params);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.mobile.playbackUrl ?? "").toContain("pb_old.m3u8?token=");

    const updates = state.calls.mutations.filter((m) => m.op === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe("post_video");
    expect(updates[0].payload).toMatchObject({ mux_playback_id: "pb_old" });

    expect(state.calls.mutations.filter((m) => m.table === "post")).toHaveLength(0);
    expect(listReadyMuxAssets).not.toHaveBeenCalled();
    expect(findMuxAssetByPassthrough).not.toHaveBeenCalled();
  });

  it("post_video read error (not missing table): signs what post holds, writes nothing, no Mux call", async () => {
    asAdmin();
    state.tables.post = {
      select: {
        single: {
          id: "p1",
          type: "video",
          status: "draft",
          mux_playback_id: "pb_1",
          mux_asset_id: null,
          poster_url: null,
          poster_time_s: null,
          aspect_ratio: null,
        },
      },
    };
    state.tables.post_video = {
      select: { error: { code: "XX000", message: "boom" } },
    };

    const r = await GET(req(), params);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.mobile.playbackUrl).toContain("pb_1.m3u8?token=");
    expect(state.calls.mutations).toEqual([]);
    expect(listReadyMuxAssets).not.toHaveBeenCalled();
    expect(findMuxAssetByPassthrough).not.toHaveBeenCalled();
  });

  it("response never carries a Mux asset or upload id", async () => {
    asAdmin();
    state.tables.post = {
      select: {
        single: {
          id: "p1",
          type: "video",
          status: "draft",
          mux_playback_id: null,
          mux_asset_id: null,
          poster_url: null,
          poster_time_s: null,
          aspect_ratio: null,
        },
      },
    };
    state.tables.post_video = {
      select: {
        rows: [
          {
            id: "v1",
            sort_order: 0,
            status: "uploading",
            mux_upload_id: null,
            mux_playback_id: null,
            poster_url: null,
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      },
      mutate: { rows: [{ id: "v1" }] },
    };
    listReadyMuxAssets.mockResolvedValue([
      { assetId: "as_1", playbackId: "pb_2", passthrough: "p1", aspectRatio: null },
    ]);

    const r = await GET(req(), params);
    const j = await r.json();
    const body = JSON.stringify(j);
    expect(body).not.toContain("as_1");
    expect(j.data.mobile).not.toHaveProperty("muxAssetId");
    expect(j.data.mobile).not.toHaveProperty("muxUploadId");
  });
});
