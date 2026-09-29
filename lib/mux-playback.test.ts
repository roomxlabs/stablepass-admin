import { describe, it, expect, beforeEach, vi } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { makeFakeClient, blankState } from "@/lib/testing/supabase-fake";

const findMuxAssetByPassthrough = vi.fn<(p: string) => Promise<{ assetId: string; playbackId: string } | null>>();
type ListedAsset = { assetId: string; playbackId: string; passthrough: string; aspectRatio: number | null };
const listReadyMuxAssets = vi.fn<() => Promise<ListedAsset[]>>();
vi.mock("@/lib/mux", () => ({
  findMuxAssetByPassthrough: (p: string) => findMuxAssetByPassthrough(p),
  listReadyMuxAssets: () => listReadyMuxAssets(),
}));

import {
  LEGACY_FALLBACK_MIN_AGE_MS,
  muxSignedStreamUrl,
  muxSignedThumbnailUrl,
  reconcilePostVideos,
  resolveVideoPlayback,
  signMuxPlaybackToken,
  type PlaybackDb,
  type PostVideoWriteDb,
  type ReconcileVideoRow,
} from "./mux-playback";

// A real (throwaway) RSA keypair so tokens can be cryptographically verified.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function setSigningEnv() {
  process.env.MUX_SIGNING_KEY_ID = "sk_test";
  process.env.MUX_SIGNING_PRIVATE_KEY = Buffer.from(
    privateKey.export({ type: "pkcs1", format: "pem" }),
  ).toString("base64");
}

function clearSigningEnv() {
  delete process.env.MUX_SIGNING_KEY_ID;
  delete process.env.MUX_SIGNING_PRIVATE_KEY;
}

/** Fake PlaybackDb that records the guarded reconcile UPDATE. */
function makeDb() {
  const calls: { table: string; values: Record<string, unknown>; eq: unknown[]; is: unknown[] }[] = [];
  const db: PlaybackDb = {
    from: (table) => ({
      update: (values) => ({
        eq: (...eq: unknown[]) => ({
          is: (...is: unknown[]) => {
            calls.push({ table, values, eq, is });
            return Promise.resolve({ error: null });
          },
        }),
      }),
    }),
  };
  return { db, calls };
}

type WriteCall = { table: string; values: Record<string, unknown>; eq: unknown[]; is: unknown[] };

/**
 * Fake `PostVideoWriteDb` for `reconcilePostVideos` — the `.select("id")` tail
 * the re-review added, so a 0-row update (RLS refused it / the webhook won the
 * race) can be told apart from a genuine write. Defaults every row to a
 * 1-row success; `resolveRow` overrides one row's `{data, error}` by id.
 */
/** What the legacy branch reads off `post` (ENG-1611 — "post wins"). */
type PostRead = { data: Record<string, unknown> | null; error: { message: string } | null };
const BLANK_POST: PostRead = {
  data: { mux_asset_id: null, mux_playback_id: null, poster_url: null, poster_time_s: null, aspect_ratio: null },
  error: null,
};

function makeWriteDb(
  resolveRow?: (rowId: string) => { data: unknown[] | null; error: { message: string } | null } | undefined,
  post: PostRead = BLANK_POST,
) {
  const calls: WriteCall[] = [];
  const reads: { table: string; columns: string; eq: unknown[] }[] = [];
  const db: PostVideoWriteDb = {
    from: (table) => ({
      select: (columns: string) => ({
        eq: (...eq: unknown[]) => ({
          maybeSingle: () => {
            reads.push({ table, columns, eq });
            return Promise.resolve(table === "post" ? post : { data: null, error: null });
          },
        }),
      }),
      update: (values) => ({
        eq: (...eq: unknown[]) => ({
          is: (...is: unknown[]) => ({
            select: () => {
              calls.push({ table, values, eq, is });
              const rowId = eq[1] as string;
              const override = resolveRow?.(rowId);
              return Promise.resolve(override ?? { data: [{ id: rowId }], error: null });
            },
          }),
        }),
      }),
    }),
  };
  return { db, calls, reads };
}

/** A write DB whose update for `failingRowId` errors. */
function makeWriteDbWithError(failingRowId: string) {
  return makeWriteDb((rowId) =>
    rowId === failingRowId ? { data: null, error: { message: "write failed" } } : undefined,
  );
}

/** A write DB whose update for `zeroRowId` matches 0 rows (still no error). */
function makeWriteDbWithZeroRows(zeroRowId: string) {
  return makeWriteDb((rowId) => (rowId === zeroRowId ? { data: [], error: null } : undefined));
}

const asset = (over: Partial<ListedAsset> & { passthrough: string }): ListedAsset => ({
  assetId: `as_${over.passthrough}`,
  playbackId: `pb_${over.passthrough}`,
  aspectRatio: null,
  ...over,
});

const row = (over: Partial<ReconcileVideoRow> & { id: string }): ReconcileVideoRow => ({
  status: "processing",
  mux_playback_id: null,
  mux_upload_id: "up_1",
  ...over,
});

// A fixed instant, and helpers for a legacy row's `created_at` relative to it —
// the re-review's legacy fallback only trusts a null-upload-id row OLDER than
// `LEGACY_FALLBACK_MIN_AGE_MS` (a fresh MV-A1 row is briefly null too, between
// its insert and the upload-id write).
const NOW = Date.parse("2024-06-01T00:00:00.000Z");
const oldEnoughAt = new Date(NOW - LEGACY_FALLBACK_MIN_AGE_MS - 1000).toISOString();
const tooRecentAt = new Date(NOW - LEGACY_FALLBACK_MIN_AGE_MS + 1000).toISOString();

beforeEach(() => {
  findMuxAssetByPassthrough.mockReset();
  listReadyMuxAssets.mockReset();
  setSigningEnv();
});

describe("signMuxPlaybackToken", () => {
  it("mints a verifiable RS256 JWT with sub=playbackId and aud=v", () => {
    const token = signMuxPlaybackToken("pb_1");
    expect(token).toBeTruthy();
    const [h, p, sig] = token!.split(".");
    const header = JSON.parse(Buffer.from(h, "base64url").toString());
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(header).toMatchObject({ alg: "RS256", kid: "sk_test" });
    expect(payload.sub).toBe("pb_1");
    expect(payload.aud).toBe("v");
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${h}.${p}`);
    expect(verifier.verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
  });

  it("mints thumbnail tokens with aud=t on the image host", () => {
    const url = muxSignedThumbnailUrl("pb_1");
    expect(url).toContain("https://image.mux.com/pb_1/thumbnail.jpg?token=");
    const payload = JSON.parse(Buffer.from(url!.split("token=")[1].split(".")[1], "base64url").toString());
    expect(payload).toMatchObject({ sub: "pb_1", aud: "t" });
  });

  it("returns null when the signing key env is not configured", () => {
    clearSigningEnv();
    expect(signMuxPlaybackToken("pb_1")).toBeNull();
    expect(muxSignedStreamUrl("pb_1")).toBeNull();
    expect(muxSignedThumbnailUrl("pb_1")).toBeNull();
  });
});

describe("resolveVideoPlayback", () => {
  it("signs directly when the webhook already set mux_playback_id (no Mux call)", async () => {
    const { db, calls } = makeDb();
    const r = await resolveVideoPlayback(db, { id: "post_1", mux_playback_id: "pb_9" });
    expect(r.playbackId).toBe("pb_9");
    expect(r.playbackUrl).toContain("https://stream.mux.com/pb_9.m3u8?token=");
    expect(findMuxAssetByPassthrough).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("reconciles from Mux by passthrough and persists via a guarded only-if-null update", async () => {
    findMuxAssetByPassthrough.mockResolvedValue({ assetId: "as_1", playbackId: "pb_2" });
    const { db, calls } = makeDb();
    const r = await resolveVideoPlayback(db, { id: "post_1", mux_playback_id: null });
    expect(findMuxAssetByPassthrough).toHaveBeenCalledWith("post_1");
    expect(r.playbackId).toBe("pb_2");
    expect(r.playbackUrl).toContain("pb_2.m3u8?token=");
    expect(calls).toEqual([
      {
        table: "post",
        values: { mux_asset_id: "as_1", mux_playback_id: "pb_2" },
        eq: ["id", "post_1"],
        is: ["mux_playback_id", null],
      },
    ]);
  });

  // ENG-993 — the guard pinned through the SHARED fake, not just the bespoke
  // one above. `app/api/admin/posts/[id]/preview` reaches this same reconcile
  // with the real `supabase-fake` client, where `.is()` used to be a pure
  // no-op: the precondition that stops a concurrent webhook write being
  // clobbered vanished before any assertion could see it. This test reads the
  // recorded filter, so deleting `.is("mux_playback_id", null)` from
  // `resolveVideoPlayback` turns it RED.
  it("records the only-if-null precondition on the shared supabase fake (lost-update guard)", async () => {
    findMuxAssetByPassthrough.mockResolvedValue({ assetId: "as_1", playbackId: "pb_2" });
    const state = blankState();
    const sb = makeFakeClient(state) as unknown as PlaybackDb;

    await resolveVideoPlayback(sb, { id: "post_1", mux_playback_id: null });

    const update = state.calls.mutations.find((m) => m.op === "update" && m.table === "post");
    expect(update).toBeDefined();
    expect(update!.payload).toEqual({ mux_asset_id: "as_1", mux_playback_id: "pb_2" });
    // Both the row selector AND the precondition must be on the chain. The
    // `is` entry is the assertion that fails if the guard is removed.
    expect(update!.filters).toEqual([
      { column: "id", value: "post_1" },
      { column: "mux_playback_id", value: null, op: "is" },
    ]);
  });

  it("returns nulls when the asset is not ready yet (and Mux errors don't throw)", async () => {
    findMuxAssetByPassthrough.mockRejectedValue(new Error("mux down"));
    const { db, calls } = makeDb();
    const r = await resolveVideoPlayback(db, { id: "post_1", mux_playback_id: null });
    expect(r).toEqual({ playbackId: null, playbackUrl: null });
    expect(calls).toHaveLength(0);
  });
});

describe("reconcilePostVideos — ENG-1598 review", () => {
  it("own-id match: writes the row with the asset's values, guarded + `.select(\"id\")`, and returns the map", async () => {
    listReadyMuxAssets.mockResolvedValue([asset({ passthrough: "pv_1", aspectRatio: 16 / 9 })]);
    const { db, calls } = makeWriteDb();
    const rows = [row({ id: "pv_1", mux_upload_id: "up_1" })];
    const out = await reconcilePostVideos(db, "post_1", rows);
    expect(listReadyMuxAssets).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      {
        table: "post_video",
        values: { mux_asset_id: "as_pv_1", mux_playback_id: "pb_pv_1", status: "ready", aspect_ratio: 16 / 9 },
        eq: ["id", "pv_1"],
        is: ["mux_playback_id", null],
      },
    ]);
    expect(out).toEqual(new Map([["pv_1", { playbackId: "pb_pv_1" }]]));
  });

  it("aspectRatio null → no aspect_ratio key on the write", async () => {
    listReadyMuxAssets.mockResolvedValue([asset({ passthrough: "pv_1", aspectRatio: null })]);
    const { db, calls } = makeWriteDb();
    await reconcilePostVideos(db, "post_1", [row({ id: "pv_1" })]);
    expect(calls[0].values).toEqual({ mux_asset_id: "as_pv_1", mux_playback_id: "pb_pv_1", status: "ready" });
    expect(calls[0].values).not.toHaveProperty("aspect_ratio");
  });

  it("0-row update (the webhook won the race, or RLS refused) → the row is absent from the map", async () => {
    listReadyMuxAssets.mockResolvedValue([asset({ passthrough: "pv_1" })]);
    const { db, calls } = makeWriteDbWithZeroRows("pv_1");
    const out = await reconcilePostVideos(db, "post_1", [row({ id: "pv_1" })]);
    expect(calls).toHaveLength(1); // the write was attempted
    expect(out.size).toBe(0);
    expect(out.has("pv_1")).toBe(false);
  });

  it("a legacy row (mux_upload_id null, created_at ≥ 10min old) falls back to postId passthrough, writing the ROW not `post`", async () => {
    listReadyMuxAssets.mockResolvedValue([asset({ passthrough: "post_1" })]);
    const { db, calls } = makeWriteDb();
    const out = await reconcilePostVideos(
      db,
      "post_1",
      [row({ id: "pv_legacy", mux_upload_id: null, created_at: oldEnoughAt })],
      NOW,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("post_video");
    expect(calls[0].eq).toEqual(["id", "pv_legacy"]);
    expect(calls[0].values).toMatchObject({ mux_asset_id: "as_post_1", mux_playback_id: "pb_post_1" });
    expect(out.get("pv_legacy")).toEqual({ playbackId: "pb_post_1" });
  });

  it("the legacy fallback is skipped for a null-upload-id row whose created_at is under 10 minutes old (a fresh MV-A1 row)", async () => {
    listReadyMuxAssets.mockResolvedValue([asset({ passthrough: "post_1" })]);
    const { db, calls } = makeWriteDb();
    const out = await reconcilePostVideos(
      db,
      "post_1",
      [row({ id: "pv_fresh", mux_upload_id: null, created_at: tooRecentAt })],
      NOW,
    );
    expect(calls).toHaveLength(0);
    expect(out.size).toBe(0);
  });

  it("the legacy fallback is skipped when created_at is missing", async () => {
    listReadyMuxAssets.mockResolvedValue([asset({ passthrough: "post_1" })]);
    const { db, calls } = makeWriteDb();
    const out = await reconcilePostVideos(
      db,
      "post_1",
      [row({ id: "pv_nodate", mux_upload_id: null, created_at: undefined })],
      NOW,
    );
    expect(calls).toHaveLength(0);
    expect(out.size).toBe(0);
  });

  it("a row WITH mux_upload_id never claims the post.id asset", async () => {
    listReadyMuxAssets.mockResolvedValue([asset({ passthrough: "post_1" })]);
    const { db, calls } = makeWriteDb();
    const out = await reconcilePostVideos(db, "post_1", [row({ id: "pv_1", mux_upload_id: "up_1" })]);
    expect(calls).toHaveLength(0);
    expect(out.size).toBe(0);
  });

  it("multiple pending rows → listing called exactly once", async () => {
    listReadyMuxAssets.mockResolvedValue([
      asset({ passthrough: "pv_1" }),
      asset({ passthrough: "pv_2" }),
    ]);
    const { db } = makeWriteDb();
    const out = await reconcilePostVideos(db, "post_1", [
      row({ id: "pv_1" }),
      row({ id: "pv_2" }),
    ]);
    expect(listReadyMuxAssets).toHaveBeenCalledTimes(1);
    expect(out.size).toBe(2);
  });

  it("rows already having a playback id or errored → listing not called, no writes", async () => {
    const { db, calls } = makeWriteDb();
    const out = await reconcilePostVideos(db, "post_1", [
      row({ id: "pv_1", mux_playback_id: "pb_already" }),
      row({ id: "pv_2", status: "errored" }),
    ]);
    expect(listReadyMuxAssets).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(out.size).toBe(0);
  });

  it("no pending rows → no listing", async () => {
    const { db } = makeWriteDb();
    await reconcilePostVideos(db, "post_1", []);
    expect(listReadyMuxAssets).not.toHaveBeenCalled();
  });

  it("listing rejects → empty map, no writes", async () => {
    listReadyMuxAssets.mockRejectedValue(new Error("mux down"));
    const { db, calls } = makeWriteDb();
    const out = await reconcilePostVideos(db, "post_1", [row({ id: "pv_1" })]);
    expect(out.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("a write error omits that row from the result, but does not stop the rest", async () => {
    listReadyMuxAssets.mockResolvedValue([
      asset({ passthrough: "pv_1" }),
      asset({ passthrough: "pv_2" }),
    ]);
    const { db } = makeWriteDbWithError("pv_1");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await reconcilePostVideos(db, "post_1", [row({ id: "pv_1" }), row({ id: "pv_2" })]);
    expect(out.has("pv_1")).toBe(false);
    expect(out.get("pv_2")).toEqual({ playbackId: "pb_pv_2" });
    spy.mockRestore();
  });

  it("one asset is never assigned to two rows (the second, legacy, row's own-id and fallback both miss)", async () => {
    // Two legacy rows would both fall back to postId — only the first claims it.
    listReadyMuxAssets.mockResolvedValue([asset({ passthrough: "post_1" })]);
    const { db, calls } = makeWriteDb();
    const out = await reconcilePostVideos(
      db,
      "post_1",
      [
        row({ id: "pv_a", mux_upload_id: null, created_at: oldEnoughAt }),
        row({ id: "pv_b", mux_upload_id: null, created_at: oldEnoughAt }),
      ],
      NOW,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].eq).toEqual(["id", "pv_a"]);
    expect(out.size).toBe(1);
    expect(out.has("pv_a")).toBe(true);
    expect(out.has("pv_b")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // ENG-1611 — "post wins": the legacy branch must carry the post's baked
  // poster + chosen frame + aspect onto the row in the SAME update as the ids.
  // The slot-0 mirror copies the row onto `post` when `mux_playback_id`
  // changes, so a write without them erased `post.poster_url` /
  // `poster_time_s` (and `aspect_ratio` when Mux returned none).
  // -------------------------------------------------------------------------
  // A backfilled legacy row is slot 0 (the migration backfilled the post's one video there).
  const legacyRow = (id = "pv_legacy", sort_order = 0) =>
    row({ id, mux_upload_id: null, created_at: oldEnoughAt, sort_order });

  it("legacy match copies post's poster_url, poster_time_s and aspect_ratio onto the row, in the same guarded update", async () => {
    listReadyMuxAssets.mockResolvedValue([asset({ passthrough: "post_1", aspectRatio: 16 / 9 })]);
    const { db, calls, reads } = makeWriteDb(undefined, {
      data: {
        mux_asset_id: null,
        mux_playback_id: null,
        poster_url: "posters/post_1.jpg",
        poster_time_s: 2.5,
        aspect_ratio: 0.5625,
      },
      error: null,
    });
    const out = await reconcilePostVideos(db, "post_1", [legacyRow()], NOW);
    expect(reads).toEqual([
      {
        table: "post",
        columns: "mux_asset_id,mux_playback_id,poster_url,poster_time_s,aspect_ratio",
        eq: ["id", "post_1"],
      },
    ]);
    expect(calls).toEqual([
      {
        table: "post_video",
        values: {
          mux_asset_id: "as_post_1",
          mux_playback_id: "pb_post_1",
          status: "ready",
          poster_url: "posters/post_1.jpg",
          poster_time_s: 2.5,
          // post wins over Mux's own ratio
          aspect_ratio: 0.5625,
        },
        eq: ["id", "pv_legacy"],
        is: ["mux_playback_id", null],
      },
    ]);
    expect(out.get("pv_legacy")).toEqual({ playbackId: "pb_post_1" });
  });

  it("legacy match: a post with no aspect_ratio takes Mux's", async () => {
    listReadyMuxAssets.mockResolvedValue([asset({ passthrough: "post_1", aspectRatio: 16 / 9 })]);
    const { db, calls } = makeWriteDb();
    await reconcilePostVideos(db, "post_1", [legacyRow()], NOW);
    expect(calls[0].values).toMatchObject({ aspect_ratio: 16 / 9, poster_url: null, poster_time_s: null });
  });

  it("legacy row when post already holds the video: copies all five columns from post and skips the Mux lookup", async () => {
    const { db, calls } = makeWriteDb(undefined, {
      data: {
        mux_asset_id: "as_webhook",
        mux_playback_id: "pb_webhook",
        poster_url: "posters/post_1.jpg",
        poster_time_s: 4,
        aspect_ratio: 1.7778,
      },
      error: null,
    });
    const out = await reconcilePostVideos(db, "post_1", [legacyRow()], NOW);
    expect(listReadyMuxAssets).not.toHaveBeenCalled();
    expect(calls).toEqual([
      {
        table: "post_video",
        values: {
          mux_asset_id: "as_webhook",
          mux_playback_id: "pb_webhook",
          status: "ready",
          poster_url: "posters/post_1.jpg",
          poster_time_s: 4,
          aspect_ratio: 1.7778,
        },
        eq: ["id", "pv_legacy"],
        is: ["mux_playback_id", null],
      },
    ]);
    expect(out.get("pv_legacy")).toEqual({ playbackId: "pb_webhook" });
  });

  it("legacy row: a failed post read skips the fallback (never writes a row that would blank post)", async () => {
    listReadyMuxAssets.mockResolvedValue([asset({ passthrough: "post_1" })]);
    const { db, calls } = makeWriteDb(undefined, { data: null, error: { message: "boom" } });
    const out = await reconcilePostVideos(db, "post_1", [legacyRow()], NOW);
    expect(calls).toHaveLength(0);
    expect(out.size).toBe(0);
  });

  it("a non-legacy row never reads post", async () => {
    listReadyMuxAssets.mockResolvedValue([asset({ passthrough: "pv_1" })]);
    const { db, reads } = makeWriteDb();
    await reconcilePostVideos(db, "post_1", [row({ id: "pv_1" })], NOW);
    expect(reads).toHaveLength(0);
  });

  it("a row with a non-null mux_upload_id, older than 10 min, is NOT legacy-matched", async () => {
    listReadyMuxAssets.mockResolvedValue([asset({ passthrough: "post_1" })]);
    const { db, calls } = makeWriteDb();
    const out = await reconcilePostVideos(
      db,
      "post_1",
      [row({ id: "pv_mv", mux_upload_id: "up_1", created_at: oldEnoughAt })],
      NOW,
    );
    expect(calls).toHaveLength(0);
    expect(out.size).toBe(0);
  });

  it("a second null-upload-id row does not claim once one has — even with a second post.id asset listed", async () => {
    listReadyMuxAssets.mockResolvedValue([
      asset({ passthrough: "post_1", assetId: "as_first", playbackId: "pb_first" }),
      asset({ passthrough: "post_1", assetId: "as_second", playbackId: "pb_second" }),
    ]);
    const { db, calls } = makeWriteDb();
    const out = await reconcilePostVideos(db, "post_1", [legacyRow("pv_a"), legacyRow("pv_b")], NOW);
    expect(calls).toHaveLength(1);
    expect(calls[0].eq).toEqual(["id", "pv_a"]);
    expect(out.has("pv_b")).toBe(false);
  });

  it("a second null-upload-id row does not claim once one was copied from post", async () => {
    listReadyMuxAssets.mockResolvedValue([asset({ passthrough: "post_1" })]);
    const { db, calls } = makeWriteDb(undefined, {
      data: { mux_asset_id: "as_w", mux_playback_id: "pb_w", poster_url: null, poster_time_s: null, aspect_ratio: null },
      error: null,
    });
    await reconcilePostVideos(db, "post_1", [legacyRow("pv_a"), legacyRow("pv_b")], NOW);
    expect(calls.map((c) => c.eq)).toEqual([["id", "pv_a"]]);
  });

  it("a legacy row NOT at slot 0 never takes post's columns: post mirrors another row, so it gets the plain post.id Mux match", async () => {
    // An edit moved another video to the front: post now holds THAT row's ids + poster.
    listReadyMuxAssets.mockResolvedValue([asset({ passthrough: "post_1", aspectRatio: 16 / 9 })]);
    const { db, calls } = makeWriteDb(undefined, {
      data: {
        mux_asset_id: "as_front",
        mux_playback_id: "pb_front",
        poster_url: "posters/front.jpg",
        poster_time_s: 1,
        aspect_ratio: 0.5625,
      },
      error: null,
    });
    const out = await reconcilePostVideos(db, "post_1", [legacyRow("pv_legacy", 1)], NOW);
    expect(calls).toEqual([
      {
        table: "post_video",
        values: { mux_asset_id: "as_post_1", mux_playback_id: "pb_post_1", status: "ready", aspect_ratio: 16 / 9 },
        eq: ["id", "pv_legacy"],
        is: ["mux_playback_id", null],
      },
    ]);
    expect(out.get("pv_legacy")).toEqual({ playbackId: "pb_post_1" });
  });
});
