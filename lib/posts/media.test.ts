// ENG-1266 — `nextPhotoSlot`, the next free upload SLOT for a post that
// already has photos. See the doc comment on the function for the contract:
// `1 + the highest photo-<n> ordinal`, floor 1, nulls ignored, slot 0
// (`<postId>/original`) never re-minted.
import { describe, expect, it } from "vitest";
import { nextPhotoSlot } from "./media";

describe("nextPhotoSlot", () => {
  it("is 1 for an empty list — the floor, since slot 0 is never re-minted", () => {
    expect(nextPhotoSlot([])).toBe(1);
  });

  it("is 1 for a lone <postId>/original — nothing to continue from", () => {
    expect(nextPhotoSlot(["p1/original"])).toBe(1);
  });

  it("is 1 + the highest ordinal, and leaves a gap alone", () => {
    // The gap case the ticket names by name: original, photo-1, photo-4
    // survive (a removed photo-2/photo-3), and the answer is 5, not 2 — a
    // removed slot's path must never be handed out again.
    expect(nextPhotoSlot(["p1/original", "p1/photo-1", "p1/photo-4"])).toBe(5);
  });

  it("ignores order — the highest ordinal wins regardless of array position", () => {
    expect(nextPhotoSlot(["p1/photo-4", "p1/original", "p1/photo-1"])).toBe(5);
  });

  it("ignores null and undefined entries", () => {
    expect(nextPhotoSlot([null, "p1/original", undefined, "p1/photo-2"])).toBe(3);
  });

  it("is 1 when every entry is null/undefined/empty", () => {
    expect(nextPhotoSlot([null, undefined])).toBe(1);
    expect(nextPhotoSlot([])).toBe(1);
  });

  it("a post id containing 'photo-9' does not inflate the ordinal — anchored to the END of the path", () => {
    // The id itself is not a photo path; only a TRAILING `photo-<n>` segment
    // counts. Without the anchor, `photo-9` embedded in the id would make
    // every post named this way believe it already has nine photos.
    expect(nextPhotoSlot(["photo-9-stable/original"])).toBe(1);
    expect(nextPhotoSlot(["photo-9-stable/original", "photo-9-stable/photo-2"])).toBe(3);
  });

  it("matches a photo-<n> segment anywhere it sits at the end, not just after a slash", () => {
    // The regex is `(?:^|\/)photo-(\d+)$` — a bare `photo-3` with no leading
    // slash still matches (the `^` branch), which is the shape a caller could
    // hand in without a postId prefix at all.
    expect(nextPhotoSlot(["photo-3"])).toBe(4);
  });

  it("takes the union across every path given, not just the first array", () => {
    // Mirrors how the route calls it: post_media rows + the mirror + the
    // Storage listing, concatenated into one array.
    const rowPaths = ["p1/original"];
    const mirror = "p1/original";
    const objectPaths = ["p1/original", "p1/photo-1", "p1/photo-2"];
    expect(nextPhotoSlot([...rowPaths, mirror, ...objectPaths])).toBe(3);
  });

  it("is monotonic — never returns a slot at or below one already seen", () => {
    // Simulates three successive appends to the same growing path list, the
    // way the route re-derives the slot on every call.
    let paths = ["p1/original"];
    const first = nextPhotoSlot(paths);
    expect(first).toBe(1);
    paths = [...paths, `p1/photo-${first}`];
    const second = nextPhotoSlot(paths);
    expect(second).toBeGreaterThan(first);
    paths = [...paths, `p1/photo-${second}`];
    const third = nextPhotoSlot(paths);
    expect(third).toBeGreaterThan(second);
  });
});
