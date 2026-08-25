// ENG-748 — the multi-photo data layer.
//
// These are the tests that have to be REAL, because everything above them is
// green regardless. The lesson from ENG-750 this session: a reviewer mutated a
// row mapping to a constant `null` and the entire suite stayed green, because
// every proof ran against hand-built fixtures that never exercised the mapping.
// So each block below is written to go RED under a specific plausible mutation,
// and the mutations were run (see the PR's mutation-check table), not imagined.
import { describe, expect, it } from "vitest";
import {
  MAX_PHOTOS,
  mediaSetPayload,
  mirrorPath,
  movePhoto,
  removePhotoAt,
  uploadSlotPath,
  uploadedPhotos,
  type ComposePhoto,
} from "./photos";

/**
 * A photo whose path deliberately does NOT match its display position, so a
 * function that derives the path from the index instead of reading it cannot
 * pass by coincidence. `slot` is the upload ordinal baked into the path.
 */
function photo(slot: number, over: Partial<ComposePhoto> = {}): ComposePhoto {
  return {
    id: `ph-${slot}`,
    path: uploadSlotPath("post-1", slot),
    previewUrl: `blob:photo-${slot}`,
    name: `photo-${slot}.jpg`,
    size: 1024 * (slot + 1),
    state: "done",
    ...over,
  };
}

/** Display order → the slot ordinals behind it, for compact assertions. */
const slots = (list: readonly ComposePhoto[]) => list.map((p) => p.path.replace("post-1/", ""));

describe("uploadSlotPath — ENG-740's path convention", () => {
  it("keeps slot 0 at <postId>/original so a single-photo post is unchanged", () => {
    expect(uploadSlotPath("abc", 0)).toBe("abc/original");
  });

  it("puts every extra at <postId>/photo-<n>, numbered by SLOT", () => {
    expect(uploadSlotPath("abc", 1)).toBe("abc/photo-1");
    expect(uploadSlotPath("abc", 9)).toBe("abc/photo-9");
    // Not photo-0, and never a URL — a bare object path (house rule).
    expect(uploadSlotPath("abc", 1)).not.toContain("://");
  });
});

describe("movePhoto — where the off-by-one bugs live", () => {
  it("swaps a two-item list in both directions", () => {
    const two = [photo(0), photo(1)];
    expect(slots(movePhoto(two, 1, -1))).toEqual(["photo-1", "original"]);
    expect(slots(movePhoto(two, 0, 1))).toEqual(["photo-1", "original"]);
  });

  it("moving the FIRST item up is a no-op, and returns the same reference", () => {
    const list = [photo(0), photo(1), photo(2)];
    const out = movePhoto(list, 0, -1);
    expect(out).toBe(list);
    expect(slots(out)).toEqual(["original", "photo-1", "photo-2"]);
  });

  it("moving the LAST item down is a no-op, and returns the same reference", () => {
    const list = [photo(0), photo(1), photo(2)];
    const out = movePhoto(list, 2, 1);
    expect(out).toBe(list);
    expect(slots(out)).toEqual(["original", "photo-1", "photo-2"]);
  });

  it("a single-item list cannot move in either direction", () => {
    const one = [photo(0)];
    expect(movePhoto(one, 0, -1)).toBe(one);
    expect(movePhoto(one, 0, 1)).toBe(one);
  });

  it("moves a middle item down by exactly ONE place, not two", () => {
    // THE splice-out-then-splice-in regression. A remove-then-reinsert with the
    // untouched index sends item 1 to the END of a four-item list; a correct
    // swap sends it to position 2.
    const four = [photo(0), photo(1), photo(2), photo(3)];
    expect(slots(movePhoto(four, 1, 1))).toEqual([
      "original",
      "photo-2",
      "photo-1",
      "photo-3",
    ]);
  });

  it("moves a middle item up by exactly one place", () => {
    const four = [photo(0), photo(1), photo(2), photo(3)];
    expect(slots(movePhoto(four, 2, -1))).toEqual([
      "original",
      "photo-2",
      "photo-1",
      "photo-3",
    ]);
  });

  it("never mutates the array it was given", () => {
    const list = [photo(0), photo(1), photo(2)];
    const before = slots(list);
    movePhoto(list, 0, 1);
    expect(slots(list)).toEqual(before);
  });

  it("preserves the set — a move loses and duplicates nothing", () => {
    const list = [photo(0), photo(1), photo(2), photo(3)];
    const moved = movePhoto(list, 2, -1);
    expect(moved).toHaveLength(4);
    expect(new Set(moved.map((p) => p.id)).size).toBe(4);
  });

  it("treats an out-of-range index as a no-op instead of corrupting the list", () => {
    const list = [photo(0), photo(1)];
    expect(movePhoto(list, 7, -1)).toBe(list);
    expect(movePhoto(list, -3, 1)).toBe(list);
  });

  it("a full round trip returns the original order", () => {
    const list = [photo(0), photo(1), photo(2)];
    expect(slots(movePhoto(movePhoto(list, 0, 1), 1, -1))).toEqual(slots(list));
  });
});

describe("removePhotoAt compacts the display order", () => {
  it("drops the middle item and closes the gap", () => {
    const list = [photo(0), photo(1), photo(2)];
    expect(slots(removePhotoAt(list, 1))).toEqual(["original", "photo-2"]);
  });

  it("drops the first item, leaving the rest in order", () => {
    const list = [photo(0), photo(1), photo(2)];
    expect(slots(removePhotoAt(list, 0))).toEqual(["photo-1", "photo-2"]);
  });

  it("empties a single-item list", () => {
    expect(removePhotoAt([photo(0)], 0)).toEqual([]);
  });

  it("ignores an out-of-range index", () => {
    const list = [photo(0)];
    expect(removePhotoAt(list, 4)).toBe(list);
  });
});

describe("mirrorPath — the compatibility seam with post.media_url", () => {
  it("is null when nothing has uploaded yet", () => {
    expect(mirrorPath([])).toBeNull();
  });

  it("is the slot-0 path for an untouched single-photo post", () => {
    expect(mirrorPath([photo(0)])).toBe("post-1/original");
  });

  it("FOLLOWS a reorder that changes which photo is position 0", () => {
    // The whole ticket in one assertion. Every existing client reads
    // post.media_url and knows nothing about post_media, so if this does not
    // move, the feed and the member card silently show a different image than
    // the admin preview — with no error anywhere.
    const list = [photo(0), photo(1), photo(2)];
    expect(mirrorPath(list)).toBe("post-1/original");

    const reordered = movePhoto(list, 2, -1); // photo-2 to the middle
    expect(mirrorPath(reordered)).toBe("post-1/original"); // position 0 unchanged

    const front = movePhoto(movePhoto(list, 2, -1), 1, -1); // photo-2 to the front
    expect(slots(front)[0]).toBe("photo-2");
    expect(mirrorPath(front)).toBe("post-1/photo-2");
  });

  it("follows a removal that promotes a new position 0", () => {
    const list = [photo(0), photo(1), photo(2)];
    expect(mirrorPath(removePhotoAt(list, 0))).toBe("post-1/photo-1");
  });

  it("skips a still-uploading photo sitting at the front", () => {
    // Pointing the mirror at bytes that are not in Storage yet 404s every
    // existing reader of post.media_url until the upload lands.
    const list = [photo(5, { state: "uploading" }), photo(0)];
    expect(mirrorPath(list)).toBe("post-1/original");
  });

  it("skips a FAILED photo at the front too", () => {
    const list = [photo(5, { state: "error", error: "network" }), photo(0)];
    expect(mirrorPath(list)).toBe("post-1/original");
  });
});

describe("mediaSetPayload — contiguity and row 0, which no CHECK can express", () => {
  it("numbers a three-photo set 0,1,2 against the DISPLAY order", () => {
    const list = [photo(2), photo(0), photo(1)];
    expect(mediaSetPayload(list)).toEqual([
      { sortOrder: 0, mediaUrl: "post-1/photo-2" },
      { sortOrder: 1, mediaUrl: "post-1/original" },
      { sortOrder: 2, mediaUrl: "post-1/photo-1" },
    ]);
  });

  it("emits CONTIGUOUS ordinals from 0 even when the slots are ragged", () => {
    // Slots 3, 7 and 9 survive; a writer that persisted the SLOT as sort_order
    // would produce {3,7,9} — legal per the CHECK, and exactly the gapped set
    // ENG-740 warns breaks a pager. Asserting the ordinals are 0..n-1 is the
    // point; asserting they merely "changed" would pass for {3,7,9}.
    const ragged = [photo(3), photo(7), photo(9)];
    const rows = mediaSetPayload(ragged);
    expect(rows.map((r) => r.sortOrder)).toEqual([0, 1, 2]);
    expect(rows[0].mediaUrl).toBe("post-1/photo-3");
  });

  it("always produces a row 0 for a non-empty set — the mirror is defined against it", () => {
    for (const list of [[photo(4)], [photo(9), photo(2)], [photo(1), photo(0), photo(5)]]) {
      const rows = mediaSetPayload(list);
      expect(rows[0].sortOrder).toBe(0);
      expect(rows[0].mediaUrl).toBe(mirrorPath(list));
    }
  });

  it("agrees with mirrorPath after every single-step reorder of a 4-photo set", () => {
    // Exhaustive over the moves the UI can actually produce, because "the
    // mirror equals row 0" is an invariant, not a happy path.
    const base = [photo(0), photo(1), photo(2), photo(3)];
    for (let i = 0; i < base.length; i++) {
      for (const dir of [-1, 1] as const) {
        const next = movePhoto(base, i, dir);
        const rows = mediaSetPayload(next);
        expect(rows.map((r) => r.sortOrder)).toEqual([0, 1, 2, 3]);
        expect(rows[0].mediaUrl).toBe(mirrorPath(next));
      }
    }
  });

  it("omits photos that are not uploaded, and renumbers around the hole", () => {
    const list = [photo(0), photo(1, { state: "error" }), photo(2)];
    expect(mediaSetPayload(list)).toEqual([
      { sortOrder: 0, mediaUrl: "post-1/original" },
      { sortOrder: 1, mediaUrl: "post-1/photo-2" },
    ]);
    expect(uploadedPhotos(list)).toHaveLength(2);
  });

  it("is empty for a set with nothing uploaded", () => {
    expect(mediaSetPayload([photo(0, { state: "uploading" })])).toEqual([]);
  });

  it("stays inside the schema's 0..9 CHECK at the operator cap", () => {
    const ten = Array.from({ length: MAX_PHOTOS }, (_, i) => photo(i));
    const rows = mediaSetPayload(ten);
    expect(rows).toHaveLength(10);
    expect(rows.at(-1)!.sortOrder).toBe(9);
    expect(rows.every((r) => r.sortOrder >= 0 && r.sortOrder <= 9)).toBe(true);
  });
});
