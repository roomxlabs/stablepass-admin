import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { createMuxDirectUpload, findMuxAssetByPassthrough } from "./mux";

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
  });

  it("returns null when nothing matches", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    expect(await findMuxAssetByPassthrough("post_1")).toBeNull();
  });
});
