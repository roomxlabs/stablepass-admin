import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  createMuxDirectUpload,
  findMuxAssetByPassthrough,
  deleteMuxAsset,
  cancelMuxUpload,
  getMuxUploadAssetId,
  cleanupMuxVideo,
  parseMuxAspectRatio,
  listReadyMuxAssets,
} from "./mux";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  process.env.MUX_TOKEN_ID = "tok_id";
  process.env.MUX_TOKEN_SECRET = "tok_secret";
  fetchMock.mockReset();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

describe("createMuxDirectUpload", () => {
  it("creates a signed-policy upload carrying passthrough in new_asset_settings", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { id: "up_1", url: "https://mux/u" } }));
    const r = await createMuxDirectUpload({ passthrough: "post_1" });
    expect(r).toEqual({ uploadId: "up_1", uploadUrl: "https://mux/u" });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.new_asset_settings).toEqual({ playback_policy: ["signed"], passthrough: "post_1" });
    // ENG-1597 review — every Mux call is bounded (MUX_TIMEOUT_MS), so a hung
    // request cannot hold an admin request open indefinitely.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("findMuxAssetByPassthrough", () => {
  it("returns the ready asset matching the passthrough, skipping others", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [
          { id: "as_other", status: "ready", passthrough: "post_9", playback_ids: [{ id: "pb_9" }] },
          { id: "as_processing", status: "preparing", passthrough: "post_1", playback_ids: [] },
          { id: "as_1", status: "ready", passthrough: "post_1", playback_ids: [{ id: "pb_1" }] },
        ],
      }),
    );
    const r = await findMuxAssetByPassthrough("post_1");
    expect(r).toEqual({ assetId: "as_1", playbackId: "pb_1" });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns null when nothing matches", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    expect(await findMuxAssetByPassthrough("post_1")).toBeNull();
  });
});

describe("parseMuxAspectRatio — ENG-1598 review", () => {
  it("parses a well-formed ratio string", () => {
    expect(parseMuxAspectRatio("16:9")).toBeCloseTo(16 / 9);
    expect(parseMuxAspectRatio("1:1")).toBe(1);
    expect(parseMuxAspectRatio("9:16")).toBeCloseTo(9 / 16);
  });

  it("tolerates surrounding whitespace and decimal components", () => {
    expect(parseMuxAspectRatio(" 4.5 : 3 ")).toBeCloseTo(4.5 / 3);
  });

  it("returns null for non-string input", () => {
    expect(parseMuxAspectRatio(undefined)).toBeNull();
    expect(parseMuxAspectRatio(null)).toBeNull();
    expect(parseMuxAspectRatio(1.777)).toBeNull();
  });

  it("returns null for malformed strings", () => {
    expect(parseMuxAspectRatio("")).toBeNull();
    expect(parseMuxAspectRatio("sixteen:nine")).toBeNull();
    expect(parseMuxAspectRatio("16-9")).toBeNull();
    expect(parseMuxAspectRatio("16:9:1")).toBeNull();
  });

  it("returns null for non-positive ratios", () => {
    expect(parseMuxAspectRatio("0:9")).toBeNull();
    expect(parseMuxAspectRatio("16:0")).toBeNull();
  });
});

describe("listReadyMuxAssets — ENG-1598 review", () => {
  it("keeps only ready assets that carry a passthrough + playback id, and parses the aspect ratio", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [
          // ready, no passthrough — never one of ours (skip).
          { id: "as_nopt", status: "ready", playback_ids: [{ id: "pb_x" }], aspect_ratio: "16:9" },
          // ready, no playback id yet — skip.
          { id: "as_nopb", status: "ready", passthrough: "pv_1", playback_ids: [] },
          // not ready — skip.
          { id: "as_prep", status: "preparing", passthrough: "pv_2", playback_ids: [{ id: "pb_2" }] },
          {
            id: "as_1",
            status: "ready",
            passthrough: "pv_3",
            playback_ids: [{ id: "pb_3" }],
            aspect_ratio: "16:9",
          },
          // malformed aspect ratio → aspectRatio null, asset still kept.
          {
            id: "as_2",
            status: "ready",
            passthrough: "pv_4",
            playback_ids: [{ id: "pb_4" }],
            aspect_ratio: "bogus",
          },
        ],
      }),
    );
    const r = await listReadyMuxAssets();
    expect(r).toEqual([
      { assetId: "as_1", playbackId: "pb_3", passthrough: "pv_3", aspectRatio: 16 / 9 },
      { assetId: "as_2", playbackId: "pb_4", passthrough: "pv_4", aspectRatio: null },
    ]);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns an empty array when nothing is listed", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    expect(await listReadyMuxAssets()).toEqual([]);
  });
});

const okResponse = () => new Response(null, { status: 200 });
const notFoundResponse = () => new Response(null, { status: 404 });
const serverErrorResponse = () => new Response(null, { status: 500 });

describe("deleteMuxAsset", () => {
  it("DELETEs the asset with the Basic auth header, url-encoding the id", async () => {
    fetchMock.mockResolvedValue(okResponse());
    await deleteMuxAsset("as one/two");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.mux.com/video/v1/assets/${encodeURIComponent("as one/two")}`);
    expect(init.method).toBe("DELETE");
    expect(init.headers.Authorization).toBe(
      `Basic ${Buffer.from("tok_id:tok_secret").toString("base64")}`,
    );
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("treats a 404 as success (already gone)", async () => {
    fetchMock.mockResolvedValue(notFoundResponse());
    await expect(deleteMuxAsset("as_1")).resolves.toBeUndefined();
  });

  it("throws MuxError on a 500", async () => {
    fetchMock.mockResolvedValue(serverErrorResponse());
    await expect(deleteMuxAsset("as_1")).rejects.toThrow("Mux asset delete failed (500).");
  });
});

describe("cancelMuxUpload", () => {
  it("PUTs the cancel endpoint", async () => {
    fetchMock.mockResolvedValue(okResponse());
    await cancelMuxUpload("up_1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.mux.com/video/v1/uploads/up_1/cancel");
    expect(init.method).toBe("PUT");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("treats a 404 as success", async () => {
    fetchMock.mockResolvedValue(notFoundResponse());
    await expect(cancelMuxUpload("up_1")).resolves.toBeUndefined();
  });

  it("throws MuxError on a 500", async () => {
    fetchMock.mockResolvedValue(serverErrorResponse());
    await expect(cancelMuxUpload("up_1")).rejects.toThrow("Mux upload cancel failed (500).");
  });
});

describe("getMuxUploadAssetId", () => {
  it("returns the asset id off the upload", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { asset_id: "as_1" } }));
    expect(await getMuxUploadAssetId("up_1")).toBe("as_1");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns null when the upload has no asset yet", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: {} }));
    expect(await getMuxUploadAssetId("up_1")).toBeNull();
  });

  it("throws MuxError on a non-2xx", async () => {
    fetchMock.mockResolvedValue(serverErrorResponse());
    await expect(getMuxUploadAssetId("up_1")).rejects.toThrow("Mux upload read failed (500).");
  });
});

describe("cleanupMuxVideo", () => {
  it("asset path: calls DELETE on the asset only, never the upload endpoints", async () => {
    fetchMock.mockResolvedValue(okResponse());
    await cleanupMuxVideo({ videoId: "v1", assetId: "as_1", uploadId: "up_1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.mux.com/video/v1/assets/as_1");
    expect(init.method).toBe("DELETE");
  });

  it("upload-only path: cancels the upload", async () => {
    fetchMock.mockResolvedValue(okResponse());
    await cleanupMuxVideo({ videoId: "v1", uploadId: "up_1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.mux.com/video/v1/uploads/up_1/cancel");
    expect(init.method).toBe("PUT");
  });

  it("cancel fails → looks up the upload's asset → deletes it", async () => {
    fetchMock
      .mockResolvedValueOnce(serverErrorResponse()) // cancel fails
      .mockResolvedValueOnce(jsonResponse({ data: { asset_id: "as_2" } })) // GET upload
      .mockResolvedValueOnce(okResponse()); // DELETE asset
    await cleanupMuxVideo({ videoId: "v1", uploadId: "up_1" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.mux.com/video/v1/uploads/up_1/cancel");
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.mux.com/video/v1/uploads/up_1");
    expect(fetchMock.mock.calls[2][0]).toBe("https://api.mux.com/video/v1/assets/as_2");
  });

  it("failure is logged as mux_cleanup_failed and resolves, never throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValue(serverErrorResponse()); // cancel fails, then GET upload fails too
    await expect(cleanupMuxVideo({ videoId: "v1", uploadId: "up_1" })).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith("mux_cleanup_failed", expect.objectContaining({ videoId: "v1" }));
    // Never logs the auth header.
    const loggedArgs = spy.mock.calls.map((c) => JSON.stringify(c));
    expect(loggedArgs.join("")).not.toContain("Basic ");
    spy.mockRestore();
  });

  it("missing Mux credentials are logged, not thrown", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.MUX_TOKEN_ID;
    delete process.env.MUX_TOKEN_SECRET;
    await expect(cleanupMuxVideo({ videoId: "v1", assetId: "as_1" })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith("mux_cleanup_failed", expect.objectContaining({ videoId: "v1" }));
    spy.mockRestore();
  });

  it("no ids at all → no-op, no fetch", async () => {
    await cleanupMuxVideo({ videoId: "v1" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
