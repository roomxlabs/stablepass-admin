// ENG-1598 — the multi-video data layer (cap, reorder, remove, slot-0 change,
// status folding, the publish/save gates and the PATCH fragment).
import { describe, expect, it } from "vitest";
import { MAX_VIDEOS as SERVER_MAX_VIDEOS } from "@/lib/posts/videos";
import {
  MAX_VIDEOS,
  applyServerStatus,
  moveVideo,
  nonVideoError,
  pollableIds,
  removeVideoAt,
  slot0Changed,
  tileFromRow,
  tileStateLabel,
  videoBlockReason,
  videoCapError,
  videoOrderPatch,
  videoSaveBlockReason,
  videoUploadTargets,
  waitingMessage,
  type ComposeVideo,
} from "./videos";

function tile(key: string, over: Partial<ComposeVideo> = {}): ComposeVideo {
  return {
    key,
    id: `id-${key}`,
    name: `${key}.mp4`,
    size: 10,
    localUrl: `blob:${key}`,
    state: "ready",
    pct: 100,
    ...over,
  };
}

describe("the cap", () => {
  it("matches the server's cap byte for byte", () => {
    expect(MAX_VIDEOS).toBe(SERVER_MAX_VIDEOS);
    expect(MAX_VIDEOS).toBe(5);
  });

  it("allows up to five in total and refuses the sixth", () => {
    expect(videoCapError(0, 5)).toBeNull();
    expect(videoCapError(4, 1)).toBeNull();
    expect(videoCapError(5, 1)).toBe(
      "You can add up to 5 videos to a post — this would make 6. Nothing was uploaded.",
    );
    expect(videoCapError(0, 6)).toBe(
      "You can add up to 5 videos to a post — you picked 6. Nothing was uploaded.",
    );
  });
});

describe("videos only", () => {
  it("accepts a pure video pick", () => {
    expect(nonVideoError([{ name: "a.mp4", type: "video/mp4" }, { name: "b.mov", type: "video/quicktime" }])).toBeNull();
  });
  it("names the photo in a mixed pick", () => {
    const msg = nonVideoError([
      { name: "a.mp4", type: "video/mp4" },
      { name: "cover.jpg", type: "image/jpeg" },
    ]);
    expect(msg).toContain("cover.jpg");
    expect(msg).toContain("can't mix photos and videos");
  });
});

describe("videoUploadTargets", () => {
  it("reads the MV-A1 per-slot targets in order", () => {
    expect(
      videoUploadTargets({
        uploads: [
          { videoId: "v0", uploadUrl: "u0" },
          { videoId: "v1", uploadUrl: "u1" },
        ],
        uploadUrl: "u0",
      }),
    ).toEqual([
      { videoId: "v0", uploadUrl: "u0" },
      { videoId: "v1", uploadUrl: "u1" },
    ]);
  });
  it("falls back to the legacy single uploadUrl with no id", () => {
    expect(videoUploadTargets({ uploadUrl: "u" })).toEqual([{ videoId: null, uploadUrl: "u" }]);
  });
  it("ignores photo-shaped entries (no videoId)", () => {
    expect(videoUploadTargets({ uploads: [{ path: "p", uploadUrl: "u" }] })).toEqual([]);
  });
});

describe("reorder and remove", () => {
  const list = [tile("a"), tile("b"), tile("c")];

  it("moves 3 → 1 in two swaps, keeping every tile", () => {
    const once = moveVideo(list, 2, -1);
    const twice = moveVideo(once, 1, -1);
    expect(twice.map((v) => v.key)).toEqual(["c", "a", "b"]);
  });
  it("moving down is a swap, not a skip", () => {
    expect(moveVideo(list, 0, 1).map((v) => v.key)).toEqual(["b", "a", "c"]);
  });
  it("refuses to move off either end", () => {
    expect(moveVideo(list, 0, -1)).toBe(list);
    expect(moveVideo(list, 2, 1)).toBe(list);
  });
  it("removes exactly the tile at the index", () => {
    expect(removeVideoAt(list, 1).map((v) => v.key)).toEqual(["a", "c"]);
    expect(removeVideoAt(list, 9)).toBe(list);
  });
});

describe("slot-0 change clears the frame", () => {
  const list = [tile("a"), tile("b"), tile("c")];
  it("is true when a reorder brings a new first video", () => {
    expect(slot0Changed(list, moveVideo(list, 1, -1))).toBe(true);
  });
  it("is true when the first video is removed", () => {
    expect(slot0Changed(list, removeVideoAt(list, 0))).toBe(true);
  });
  it("is false when only later tiles move", () => {
    expect(slot0Changed(list, moveVideo(list, 2, -1))).toBe(false);
    expect(slot0Changed(list, removeVideoAt(list, 2))).toBe(false);
  });
});

describe("applyServerStatus", () => {
  const rows = (status: string, id = "id-a") => [
    { id, sortOrder: 0, status, posterUrl: "https://poster/a", playbackUrl: "https://hls/a" },
  ];

  it("processing → ready carries the poster and playback", () => {
    const [v] = applyServerStatus([tile("a", { state: "processing" })], rows("ready"));
    expect(v.state).toBe("ready");
    expect(v.posterUrl).toBe("https://poster/a");
    expect(v.playbackUrl).toBe("https://hls/a");
  });
  it("errored → failed", () => {
    const [v] = applyServerStatus([tile("a", { state: "processing" })], rows("errored"));
    expect(v.state).toBe("failed");
  });
  it("never touches a tile whose bytes are still uploading", () => {
    const list = [tile("a", { state: "uploading", pct: 40 })];
    expect(applyServerStatus(list, rows("ready"))).toBe(list);
  });
  it("never resurrects a tile whose PUT failed", () => {
    const list = [tile("a", { state: "failed" })];
    expect(applyServerStatus(list, rows("uploading"))).toBe(list);
  });
  it("returns the same array when nothing changed (no re-render loop)", () => {
    const list = [tile("a", { state: "processing" })];
    const once = applyServerStatus(list, rows("uploading"));
    expect(applyServerStatus(once, rows("uploading"))).toBe(once);
  });
  it("leaves a tile the read did not return alone", () => {
    const list = [tile("a", { state: "processing" })];
    expect(applyServerStatus(list, rows("ready", "other"))).toBe(list);
  });
  it("polls only processing tiles with an id", () => {
    expect(
      pollableIds([
        tile("a", { state: "processing" }),
        tile("b", { state: "uploading" }),
        tile("c", { state: "ready" }),
        tile("d", { state: "processing", id: null }),
      ]),
    ).toEqual(["id-a"]);
  });
});

describe("the publish gate", () => {
  it("waits for every video, and says how many", () => {
    expect(
      videoBlockReason([tile("a"), tile("b", { state: "processing" }), tile("c", { state: "uploading" })]),
    ).toBe("Waiting for 2 videos to finish processing");
    expect(waitingMessage(1)).toBe("Waiting for 1 video to finish processing");
  });
  it("a failed tile blocks until it is removed", () => {
    const list = [tile("a"), tile("b", { state: "failed" })];
    expect(videoBlockReason(list)).toContain("Remove it");
    expect(videoBlockReason(removeVideoAt(list, 1))).toBeNull();
  });
  it("opens when all are ready", () => {
    expect(videoBlockReason([tile("a"), tile("b"), tile("c")])).toBeNull();
  });
  it("an empty set is not a post", () => {
    expect(videoBlockReason([])).toBe("A video post needs at least one video.");
  });
});

describe("the edit save gate", () => {
  it("allows a live post to keep a newly added video processing", () => {
    expect(videoSaveBlockReason([tile("a"), tile("b", { state: "processing" })], { live: true })).toBeNull();
  });
  it("refuses a not-ready cover on a live post, but not on a draft", () => {
    const list = [tile("b", { state: "processing" }), tile("a")];
    expect(videoSaveBlockReason(list, { live: true })).toContain("must be ready");
    expect(videoSaveBlockReason(list, { live: false })).toBeNull();
  });
  it("refuses bytes in flight, failures and an empty set", () => {
    expect(videoSaveBlockReason([tile("a", { state: "uploading" })], { live: false })).toContain("uploading");
    expect(videoSaveBlockReason([tile("a", { state: "failed" })], { live: false })).toContain("failed");
    expect(videoSaveBlockReason([], { live: false })).toContain("at least one");
  });
});

describe("videoOrderPatch", () => {
  const list = [tile("a"), tile("b"), tile("c")];
  const server = ["id-a", "id-b", "id-c"];
  it("is absent when nothing moved", () => {
    expect(videoOrderPatch(list, server)).toEqual({});
  });
  it("sends the full new order plus what we last knew", () => {
    expect(videoOrderPatch(moveVideo(list, 2, -1), server)).toEqual({
      videos: ["id-a", "id-c", "id-b"],
      knownVideos: server,
    });
  });
  it("a removal is the set without it", () => {
    expect(videoOrderPatch(removeVideoAt(list, 1), server)).toEqual({
      videos: ["id-a", "id-c"],
      knownVideos: server,
    });
  });
  it("never sends an empty set or one with a legacy id-less tile", () => {
    expect(videoOrderPatch([], server)).toEqual({});
    expect(videoOrderPatch([tile("a", { id: null })], [])).toEqual({});
  });
});

describe("tiles from existing rows", () => {
  it("maps the server status and keeps the signed urls", () => {
    const v = tileFromRow({ id: "x", sortOrder: 1, status: "uploading", posterUrl: null, playbackUrl: "h" });
    expect(v).toMatchObject({ id: "x", state: "processing", playbackUrl: "h", localUrl: null, name: "Video 2" });
    expect(tileFromRow({ id: "y", sortOrder: 0, status: "ready", posterUrl: "p", playbackUrl: null }).state).toBe("ready");
  });
  it("labels each state", () => {
    expect(tileStateLabel(tile("a", { state: "uploading", pct: 42 }))).toBe("uploading 42%");
    expect(tileStateLabel(tile("a", { state: "processing" }))).toBe("processing…");
    expect(tileStateLabel(tile("a", { state: "failed" }))).toBe("failed — remove and re-add");
  });
});
