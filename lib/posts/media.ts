/**
 * The `post_media` write contract — the ONE copy of it in this repo.
 *
 * Shared by the BFF routes and the Compose screen for the same reason
 * `lib/posts/labels.ts` is: the path convention and the cap have to be identical
 * on both sides, and two copies of a convention is how the browser uploads bytes
 * to one path while the server records another.
 *
 * The source of truth is stablepass-be's `20260819120002_post_media.sql` (ENG-740)
 * plus the `post_media` section of its `docs/specs/api-contract.md`. What that
 * contract fixes, and this module encodes:
 *
 *  1. `media_url` is a bare OBJECT PATH in the private `post-media` bucket, never
 *     a URL (house rule). Row 0 may remain `<postId>/original`; extras live at
 *     `<postId>/photo-<n>` and the existing `storage.objects` policies admit them
 *     on exactly the same terms, so multi-photo needs no storage change.
 *  2. The CAP OF TEN IS STRUCTURAL — `unique (post_id, sort_order)` plus
 *     `check (sort_order between 0 and 9)` admits at most ten rows per post.
 *     ENG-740 explicitly asks the writer NOT to re-implement a count guard the
 *     schema already provides, so `MAX_PHOTOS` here is an operator-facing message
 *     and a request-body sanity bound, not the boundary.
 *  3. What the DB CANNOT express, and the writer therefore owes:
 *       * CONTIGUITY — `{0,3,7}` is legal and is three photos with gaps, which is
 *         what would actually break a pager.
 *       * ROW 0 EXISTING — `post.media_url` mirrors sort_order 0, so a set that
 *         starts at 1 has nothing to mirror.
 *     `normaliseMediaSet` is the single place both are enforced server-side.
 *  4. `post.media_url` MIRRORS the sort_order 0 row, maintained by the WRITER
 *     (deliberately no trigger — one admin-gated writer exists). Every existing
 *     client reads the mirror and knows nothing about `post_media`, so a reorder
 *     that changes position 0 without moving the mirror shows the feed and the
 *     member card a different image than the admin preview. Silently.
 */

/**
 * The operator-facing cap. The DATABASE is the real boundary (see above); this
 * exists so picking an eleventh file fails immediately with a sentence rather
 * than after ten uploads with a constraint error.
 */
export const MAX_PHOTOS = 10;

/** Postgres unique_violation — a duplicate `(post_id, sort_order)`. */
export const UNIQUE_VIOLATION = "23505";
/** Postgres check_violation — a `sort_order` outside 0..9. */
export const CHECK_VIOLATION = "23514";

/** The CHECK bounding `sort_order`, by name. */
export const SORT_ORDER_CONSTRAINT = "post_media_sort_order_range";

export const MEDIA_ERROR_MESSAGE = `media must be a list of 1 to ${MAX_PHOTOS} distinct storage object paths, in display order.`;

/**
 * Where an upload SLOT's bytes go.
 *
 * Slot 0 keeps `<postId>/original` so a single-photo post is byte-identical to
 * what this screen has always produced, and so a legacy post's existing object
 * already sits at the slot-0 path. Extras take `<postId>/photo-<n>`, exactly as
 * ENG-740's migration documents.
 *
 * `slot` is the UPLOAD ordinal, NEVER the display position. Reordering the strip
 * does not move bytes; it changes which path row 0 points at.
 */
export function uploadSlotPath(postId: string, slot: number): string {
  return slot === 0 ? `${postId}/original` : `${postId}/photo-${slot}`;
}

/**
 * True for a `post_media` write rejected by the table's own ordering
 * constraints — a duplicate ordinal, or one outside 0..9.
 *
 * Scoped the way `isLabelCheckViolation` is: a bare `23514` would also swallow
 * `post`'s own `type` / `status` / `aspect_ratio` CHECKs, so the check_violation
 * arm additionally requires the constraint NAME. `23505` needs no such narrowing
 * — `post_media` has exactly one unique constraint.
 */
export function isMediaOrderViolation(error: {
  code?: string;
  message?: string;
  details?: string;
} | null): boolean {
  if (!error) return false;
  if (error.code === UNIQUE_VIOLATION) return true;
  if (error.code !== CHECK_VIOLATION) return false;
  return `${error.message ?? ""} ${error.details ?? ""}`.includes(SORT_ORDER_CONSTRAINT);
}

/**
 * True when the failure is "`post_media` is not there at all", rather than a
 * problem with what we tried to write.
 *
 * This exists because of a DEPLOY-ORDER hazard this ticket introduced. Before
 * ENG-748 a photo post touched only `post`; now every photo save also writes
 * `post_media`, so admin deployed AHEAD of stablepass-be's migration would 400
 * on posts that used to work — including single-photo ones, which have no need
 * of the table at all. The gate (ENG-764) sequences be-deploys-first, but a
 * regression that depends on humans getting an order right is still a
 * regression.
 *
 * Postgres raises `42P01` (undefined_table); PostgREST usually answers from its
 * schema cache first with `PGRST205`, so both are matched. Nothing else is —
 * this must not swallow a permissions or constraint failure.
 */
export function isMissingMediaTable(error: {
  code?: string;
  message?: string;
} | null): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  // Defensive: some PostgREST versions report the cache miss with no usable
  // code. Require the table name so this cannot match an unrelated failure.
  const m = error.message ?? "";
  return /could not find the table/i.test(m) && m.includes("post_media");
}

/**
 * Normalise a `media` array off a request body into the rows to persist.
 *
 * Accepts the paths in DISPLAY order — either bare strings or
 * `{ mediaUrl }` objects, since the client sends the latter — and returns
 * `{ sortOrder, mediaUrl }` numbered contiguously from 0. Returns `null` when
 * the value is unusable, which the caller turns into a 400.
 *
 * The ordinals are assigned HERE from the array index rather than trusted off
 * the wire. A client-supplied `sortOrder` is exactly how a gapped `{0,3,7}` set
 * reaches a table whose CHECK cannot see it, and it is also how two rows collide
 * on the same ordinal; deriving them makes both unrepresentable rather than
 * merely rejected.
 *
 * `postId`, when given, additionally requires every path to sit under that
 * post's prefix — see the check below.
 *
 * Duplicate paths are refused rather than de-duplicated: two ordered rows
 * pointing at one object is a writer bug, and silently collapsing it would
 * change the count the operator just saw in the strip.
 */
export function normaliseMediaSet(
  value: unknown,
  postId?: string,
): { sortOrder: number; mediaUrl: string }[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0 || value.length > MAX_PHOTOS) return null;

  const paths: string[] = [];
  for (const entry of value) {
    const raw =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object" && typeof (entry as { mediaUrl?: unknown }).mediaUrl === "string"
          ? (entry as { mediaUrl: string }).mediaUrl
          : null;
    if (raw === null) return null;
    const path = raw.trim();
    // A bare object path, never a URL (house rule) and never absolute — a
    // leading slash or a scheme here would be signed into a 404 at read time.
    if (!path || path.startsWith("/") || path.includes("://")) return null;
    // ENG-740's convention is `<postId>/original` and `<postId>/photo-<n>`, so
    // an object belonging to a DIFFERENT post is not a valid member of this
    // post's set. Without this, `PATCH /posts/A { media: ["B/original"] }`
    // cross-links B's object into A's row 0 and therefore into A's mirror.
    // Admin-only, so not a privilege escalation — but it makes the validation
    // actually enforce the convention it claims to check, and it turns a
    // copy-paste of the wrong id into a 400 instead of two posts sharing a
    // photo that either can later delete.
    if (postId && !path.startsWith(`${postId}/`)) return null;
    paths.push(path);
  }

  if (new Set(paths).size !== paths.length) return null;
  return paths.map((mediaUrl, sortOrder) => ({ sortOrder, mediaUrl }));
}
