import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

vi.mock("@/lib/mux", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mux")>("@/lib/mux");
  return {
    ...actual,
    createMuxDirectUpload: vi.fn(),
    cleanupMuxVideo: vi.fn().mockResolvedValue(undefined),
  };
});

import { createMuxDirectUpload, cleanupMuxVideo } from "@/lib/mux";
import {
  MAX_VIDEOS,
  parseVideoCount,
  parseVideoOrder,
  isMissingVideoTable,
  isSlotConflict,
  isSlotRange,
  loadPostVideos,
  mintVideoUploads,
  cleanupVideos,
  notReadyVideoIds,
  videosNotReadyResponse,
  videoGate,
} from "./videos";

const U1 = "11111111-1111-1111-1111-111111111111";
const U2 = "22222222-2222-2222-2222-222222222222";
const U3 = "33333333-3333-3333-3333-333333333333";
const U4 = "44444444-4444-4444-4444-444444444444";
const U5 = "55555555-5555-5555-5555-555555555555";
const U6 = "66666666-6666-6666-6666-666666666666";

const mockedCreate = vi.mocked(createMuxDirectUpload);
const mockedCleanup = vi.mocked(cleanupMuxVideo);

/** The fake client, typed as the `SupabaseClient` every function under test declares. */
function fakeSb(s: FakeState): SupabaseClient {
  return makeFakeClient(s) as unknown as SupabaseClient;
}

let state: FakeState;
beforeEach(() => {
  state = blankState();
  mockedCreate.mockReset();
  mockedCleanup.mockReset().mockResolvedValue(undefined);
});

describe("parseVideoCount", () => {
  it("absent/null → 1", () => {
    expect(parseVideoCount(undefined)).toBe(1);
    expect(parseVideoCount(null)).toBe(1);
  });

  it.each([1, 2, 3, 4, 5])("accepts an integer in range (%i)", (n) => {
    expect(parseVideoCount(n)).toBe(n);
  });

  it.each([0, 6, -1, 2.5, "3", NaN, {}, []])("rejects out-of-range/non-integer (%j)", (v) => {
    expect(parseVideoCount(v)).toBeNull();
  });
});

describe("parseVideoOrder", () => {
  it("accepts 1..MAX_VIDEOS distinct uuids", () => {
    expect(parseVideoOrder([U1])).toEqual([U1]);
    expect(parseVideoOrder([U1, U2, U3, U4, U5])).toEqual([U1, U2, U3, U4, U5]);
  });

  it("rejects a non-array", () => {
    expect(parseVideoOrder(U1)).toBeNull();
    expect(parseVideoOrder(undefined)).toBeNull();
    expect(parseVideoOrder({ 0: U1 })).toBeNull();
  });

  it("rejects an empty array", () => {
    expect(parseVideoOrder([])).toBeNull();
  });

  it("rejects more than MAX_VIDEOS entries", () => {
    expect(parseVideoOrder([U1, U2, U3, U4, U5, U6])).toBeNull();
    expect([U1, U2, U3, U4, U5, U6]).toHaveLength(MAX_VIDEOS + 1);
  });

  it("rejects a duplicate id", () => {
    expect(parseVideoOrder([U1, U2, U1])).toBeNull();
  });

  it("rejects a non-uuid entry", () => {
    expect(parseVideoOrder([U1, "not-a-uuid"])).toBeNull();
    expect(parseVideoOrder([U1, 123])).toBeNull();
  });
});

describe("isMissingVideoTable", () => {
  it("matches 42P01 and PGRST205", () => {
    expect(isMissingVideoTable({ code: "42P01" })).toBe(true);
    expect(isMissingVideoTable({ code: "PGRST205" })).toBe(true);
  });

  it("matches a 'could not find the table' message naming post_video", () => {
    expect(
      isMissingVideoTable({ message: "Could not find the table 'public.post_video' in the schema cache" }),
    ).toBe(true);
  });

  it("does not match an unrelated error, or a matching message for a different table", () => {
    expect(isMissingVideoTable({ code: "23505" })).toBe(false);
    expect(isMissingVideoTable({ message: "could not find the table 'public.post_media'" })).toBe(false);
    expect(isMissingVideoTable(null)).toBe(false);
  });
});

describe("isSlotConflict / isSlotRange", () => {
  it("isSlotConflict matches 23505 only", () => {
    expect(isSlotConflict({ code: "23505" })).toBe(true);
    expect(isSlotConflict({ code: "23514" })).toBe(false);
    expect(isSlotConflict(null)).toBe(false);
  });

  it("isSlotRange matches 23514 only", () => {
    expect(isSlotRange({ code: "23514" })).toBe(true);
    expect(isSlotRange({ code: "23505" })).toBe(false);
    expect(isSlotRange(null)).toBe(false);
  });
});

describe("loadPostVideos", () => {
  it("reads post_video ordered by sort_order, scoped to the post", async () => {
    state.tables.post_video = {
      select: {
        rows: [
          { id: U1, sort_order: 0, status: "ready", mux_upload_id: null, mux_asset_id: "as_1" },
          { id: U2, sort_order: 1, status: "uploading", mux_upload_id: "up_2", mux_asset_id: null },
        ],
      },
    };
    const sb = fakeSb(state);
    const { rows, error } = await loadPostVideos(sb, "post_1");
    expect(error).toBeNull();
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(U1);
    expect(state.calls.modifiers).toContainEqual({
      table: "post_video",
      kind: "order",
      args: ["sort_order", undefined],
    });
  });

  it("surfaces a query error, empty rows", async () => {
    state.tables.post_video = { select: { error: { code: "42P01" } } };
    const sb = fakeSb(state);
    const { rows, error } = await loadPostVideos(sb, "post_1");
    expect(rows).toEqual([]);
    expect(error).toEqual({ code: "42P01" });
  });
});

describe("mintVideoUploads", () => {
  it("mints one upload per row in order and records mux_upload_id on each", async () => {
    mockedCreate
      .mockResolvedValueOnce({ uploadId: "up_1", uploadUrl: "https://mux/u1" })
      .mockResolvedValueOnce({ uploadId: "up_2", uploadUrl: "https://mux/u2" });
    const sb = fakeSb(state);

    const result = await mintVideoUploads([{ id: U1 }, { id: U2 }], sb);
    expect(result).toEqual({
      ok: true,
      uploads: [
        { videoId: U1, uploadUrl: "https://mux/u1" },
        { videoId: U2, uploadUrl: "https://mux/u2" },
      ],
    });
    expect(mockedCreate).toHaveBeenNthCalledWith(1, { passthrough: U1 });
    expect(mockedCreate).toHaveBeenNthCalledWith(2, { passthrough: U2 });
    expect(state.calls.mutations).toEqual([
      { table: "post_video", op: "update", payload: { mux_upload_id: "up_1" }, filters: [{ column: "id", value: U1 }] },
      { table: "post_video", op: "update", payload: { mux_upload_id: "up_2" }, filters: [{ column: "id", value: U2 }] },
    ]);
    expect(mockedCleanup).not.toHaveBeenCalled();
  });

  it("Mux failure on the 2nd row → cleans up only the 1st (never minted at Mux for the 2nd)", async () => {
    mockedCreate
      .mockResolvedValueOnce({ uploadId: "up_1", uploadUrl: "https://mux/u1" })
      .mockRejectedValueOnce(new Error("mux down"));
    const sb = fakeSb(state);

    const result = await mintVideoUploads([{ id: U1 }, { id: U2 }], sb);
    expect(result).toEqual({ ok: false, reason: "mux" });
    expect(mockedCleanup).toHaveBeenCalledTimes(1);
    expect(mockedCleanup).toHaveBeenCalledWith({ videoId: U1, uploadId: "up_1" });
  });

  it("DB write failure on the 2nd row → cleans up BOTH (including the one whose DB write failed)", async () => {
    mockedCreate
      .mockResolvedValueOnce({ uploadId: "up_1", uploadUrl: "https://mux/u1" })
      .mockResolvedValueOnce({ uploadId: "up_2", uploadUrl: "https://mux/u2" });
    let calls = 0;
    Object.defineProperty(state.tables, "post_video", {
      configurable: true,
      get() {
        calls++;
        return { mutate: { error: calls === 2 ? { code: "500" } : null } };
      },
    });
    const sb = fakeSb(state);

    const result = await mintVideoUploads([{ id: U1 }, { id: U2 }], sb);
    expect(result).toEqual({ ok: false, reason: "db" });
    expect(mockedCleanup).toHaveBeenCalledTimes(2);
    expect(mockedCleanup).toHaveBeenCalledWith({ videoId: U1, uploadId: "up_1" });
    expect(mockedCleanup).toHaveBeenCalledWith({ videoId: U2, uploadId: "up_2" });
  });
});

describe("cleanupVideos", () => {
  it("calls cleanupMuxVideo for every row with its asset/upload ids, and resolves", async () => {
    const rows = [
      { id: U1, sort_order: 0, status: "ready", mux_upload_id: null, mux_asset_id: "as_1" },
      { id: U2, sort_order: 1, status: "uploading", mux_upload_id: "up_2", mux_asset_id: null },
    ];
    await expect(cleanupVideos(rows)).resolves.toBeUndefined();
    expect(mockedCleanup).toHaveBeenCalledWith({ videoId: U1, assetId: "as_1", uploadId: null });
    expect(mockedCleanup).toHaveBeenCalledWith({ videoId: U2, assetId: null, uploadId: "up_2" });
  });
});

describe("notReadyVideoIds", () => {
  it("returns the ids of rows not yet ready, in sort order", async () => {
    state.tables.post_video = {
      select: {
        rows: [
          { id: U1, status: "ready" },
          { id: U2, status: "uploading" },
          { id: U3, status: "errored" },
        ],
      },
    };
    const sb = fakeSb(state);
    const result = await notReadyVideoIds(sb, "post_1");
    expect(result).toEqual({ notReady: [U2, U3] });
  });

  it("all ready → empty", async () => {
    state.tables.post_video = { select: { rows: [{ id: U1, status: "ready" }] } };
    const sb = fakeSb(state);
    expect(await notReadyVideoIds(sb, "post_1")).toEqual({ notReady: [] });
  });

  it("missing table → notReady: [] (pre-deploy compat, proceeds)", async () => {
    state.tables.post_video = { select: { error: { code: "42P01" } } };
    const sb = fakeSb(state);
    expect(await notReadyVideoIds(sb, "post_1")).toEqual({ notReady: [] });
  });

  it("other error → { error: true }, logs the code", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    state.tables.post_video = { select: { error: { code: "500" } } };
    const sb = fakeSb(state);
    expect(await notReadyVideoIds(sb, "post_1")).toEqual({ error: true });
    expect(spy).toHaveBeenCalledWith("post_video query_failed", "500");
    spy.mockRestore();
  });
});

describe("videosNotReadyResponse", () => {
  it("409 with the videos_not_ready code and the ids", async () => {
    const r = videosNotReadyResponse([U1, U2]);
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j).toEqual({
      error: {
        code: "videos_not_ready",
        message: "Every video must finish processing before this post can go live.",
        notReady: [U1, U2],
      },
    });
  });
});

describe("videoGate", () => {
  it("null when every video is ready", async () => {
    state.tables.post_video = { select: { rows: [{ id: U1, status: "ready" }] } };
    const sb = fakeSb(state);
    expect(await videoGate(sb, "post_1")).toBeNull();
  });

  it("409 videos_not_ready when some are not", async () => {
    state.tables.post_video = { select: { rows: [{ id: U1, status: "uploading" }] } };
    const sb = fakeSb(state);
    const r = await videoGate(sb, "post_1");
    expect(r).not.toBeNull();
    expect(r!.status).toBe(409);
    const j = await r!.json();
    expect(j.error.code).toBe("videos_not_ready");
  });

  it("400 query_failed on a real query error", async () => {
    state.tables.post_video = { select: { error: { code: "500" } } };
    const sb = fakeSb(state);
    const r = await videoGate(sb, "post_1");
    expect(r!.status).toBe(400);
    const j = await r!.json();
    expect(j.error.code).toBe("query_failed");
  });

  it("proceeds (null) when the table is missing", async () => {
    state.tables.post_video = { select: { error: { code: "42P01" } } };
    const sb = fakeSb(state);
    expect(await videoGate(sb, "post_1")).toBeNull();
  });
});
