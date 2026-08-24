// ENG-748 — the multi-photo data layer for Compose.
//
// Kept as PURE functions in their own module, apart from the component, because
// this is the compatibility seam with stablepass-be's `post_media` (ENG-740) and
// it is where the two bug classes this ticket exists to avoid actually live:
// off-by-one reordering, and a `post.media_url` mirror that stops agreeing with
// display position 0.
//
// THE CONTRACT WE ARE CONSUMING (ENG-740's merged migration + api-contract.md):
//   * `post_media(post_id, sort_order, media_url)`, `unique (post_id, sort_order)`,
//     `check (sort_order between 0 and 9)`. The CAP OF TEN IS STRUCTURAL — the
//     schema admits at most ten ordinals per post — so nothing here re-implements
//     a count guard the database already provides. `MAX_PHOTOS` exists to give
//     the OPERATOR a message before they wait on ten uploads, not as the boundary.
//   * `media_url` is a bare OBJECT PATH in the private `post-media` bucket, never
//     a URL (house rule). Extras at `<postId>/photo-<n>`; row 0 may remain
//     `<postId>/original`.
//   * What the DB does NOT enforce, and the writer therefore owes: CONTIGUITY
//     (`{0,3,7}` is legal today and is what would actually break a pager) and the
//     EXISTENCE OF ROW 0 (the mirror is defined against it). `mediaSetPayload`
//     is the single place both are made true.
//   * `post.media_url` MIRRORS the sort_order 0 row. Every existing client — both
//     front ends, `feed_page`'s `select p.*` — reads the mirror and knows nothing
//     about this table, so a reorder that moves a different photo to position 0
//     WITHOUT moving the mirror makes the feed and the member card show a
//     different image than the admin preview just promised. That is silent: no
//     error, no red test, just the wrong picture. `mirrorPath` is the one
//     function that answers "what does media_url have to be now", and every
//     write path goes through it.

/**
 * The operator-facing cap. The DATABASE is the real boundary (see above); this
 * exists so picking eleven files fails immediately with a sentence instead of
 * after ten uploads with a constraint error.
 */
export const MAX_PHOTOS = 10;

/** One photo in the compose strip, in DISPLAY order within the list. */
export type ComposePhoto = {
  /**
   * Stable React key. Deliberately NOT the array index and NOT the path:
   * reordering changes an item's index every time, and remounting the <img> on
   * every move would re-fetch/re-decode the thumbnail and flash the strip.
   */
  id: string;
  /**
   * The Storage object path this photo's bytes were uploaded to, and therefore
   * the value that becomes `post_media.media_url`.
   *
   * FIXED AT UPLOAD TIME AND NEVER REWRITTEN BY A REORDER. This is the single
   * most important invariant in this file. The path encodes the upload SLOT
   * (`<postId>/photo-3`), not the display position — moving that photo to the
   * front does not move its bytes, it changes which path row 0 (and so the
   * mirror) points at. Deriving the path from the display index instead would
   * make every reorder claim the bytes had moved, and the card would render a
   * path with nothing behind it.
   */
  path: string;
  /** Local object URL (create flow) or signed URL (existing photo); null if neither. */
  previewUrl: string | null;
  /** Original filename for the strip's meta line. */
  name: string;
  size: number;
  /** Upload lifecycle for THIS photo — the strip shows per-photo failure. */
  state: "uploading" | "done" | "error";
  error?: string;
  /**
   * Retained so a failed upload can be retried against the SAME slot path,
   * rather than re-picked into a new one and leaving the first orphaned.
   */
  file?: File;
};

/**
 * Where an upload SLOT's bytes go. Slot 0 keeps `<postId>/original` so a
 * single-photo post is byte-identical to what this screen has always produced
 * (and so a legacy post's existing object is already at the slot-0 path);
 * extras take `<postId>/photo-<n>` exactly as ENG-740's migration documents.
 *
 * `slot` is the UPLOAD ordinal, never the display position — see `ComposePhoto.path`.
 */
export function uploadSlotPath(postId: string, slot: number): string {
  return slot === 0 ? `${postId}/original` : `${postId}/photo-${slot}`;
}

/**
 * Move the photo at `index` one place toward the front (`-1`) or back (`+1`).
 *
 * Returns the SAME array reference when the move is a no-op — first-item-up and
 * last-item-down — so a caller can cheaply tell "nothing happened" and React
 * skips the re-render. Every other case returns a new array; the input is never
 * mutated, because the previous list is what the strip renders while a save is
 * in flight.
 *
 * The bounds check is `index <= 0` / `index >= list.length - 1` rather than
 * `=== 0` / `=== length - 1` so an out-of-range index (a stale click on a photo
 * that has since been removed) is also a no-op instead of splicing at a
 * negative offset and silently duplicating an entry.
 */
export function movePhoto(
  list: readonly ComposePhoto[],
  index: number,
  direction: -1 | 1,
): ComposePhoto[] {
  if (direction === -1 && index <= 0) return list as ComposePhoto[];
  if (direction === 1 && index >= list.length - 1) return list as ComposePhoto[];
  if (index < 0 || index >= list.length) return list as ComposePhoto[];

  const next = [...list];
  const target = index + direction;
  // A straight two-element swap. Not a splice-out-then-splice-in: with the
  // remove happening first, the reinsertion index for a downward move is off by
  // one, which is the classic form of this bug and reads as "move down by two"
  // for every item but the last.
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Drop the photo at `index`; the remaining display order simply closes up. */
export function removePhotoAt(list: readonly ComposePhoto[], index: number): ComposePhoto[] {
  if (index < 0 || index >= list.length) return list as ComposePhoto[];
  return list.filter((_, i) => i !== index);
}

/**
 * The photos that actually have bytes in Storage, in display order.
 *
 * A photo still uploading or failed is NOT persisted: writing a `post_media`
 * row for it would be an ordered row pointing at an object that does not exist,
 * which is precisely the "no orphan post_media row without its object" rule.
 */
export function uploadedPhotos(list: readonly ComposePhoto[]): ComposePhoto[] {
  return list.filter((p) => p.state === "done");
}

/**
 * What `post.media_url` must equal: the path of DISPLAY POSITION 0, or null when
 * there is nothing uploaded yet.
 *
 * Reads position 0 of the UPLOADED set, not of the raw list — if the operator
 * puts a still-uploading photo at the front, the mirror must keep pointing at a
 * real object until those bytes land, or every existing client renders a 404.
 */
export function mirrorPath(list: readonly ComposePhoto[]): string | null {
  return uploadedPhotos(list)[0]?.path ?? null;
}

/**
 * The `post_media` set to persist: contiguous `sort_order` 0..n-1 over the
 * uploaded photos, in display order.
 *
 * Contiguity and row-0 existence are BOTH produced here by construction —
 * `sortOrder` is the array index of a densely-filtered list, so it cannot skip
 * and cannot start at 1. ENG-740 asks the writer for exactly these two
 * properties and can express neither as a CHECK.
 */
export function mediaSetPayload(
  list: readonly ComposePhoto[],
): { sortOrder: number; mediaUrl: string }[] {
  return uploadedPhotos(list).map((p, i) => ({ sortOrder: i, mediaUrl: p.path }));
}
