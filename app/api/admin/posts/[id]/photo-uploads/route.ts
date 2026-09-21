import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";
import { MAX_PHOTOS, nextPhotoSlot, uploadSlotPath } from "@/lib/posts/media";
import { POST_MEDIA_BUCKET } from "@/lib/storage/photos";
import { isUuid } from "@/lib/uuid";

// POST /api/admin/posts/:id/photo-uploads  { count } → signed Storage upload
// targets for `count` NEW photo slots on an existing photo post (ENG-1266).
//
// Why this exists: `POST /api/admin/posts` mints every target at CREATE time
// from `photoCount`, so once the draft exists there is no way to get another
// one. "Add more photos" — in the create draft and when editing a published
// post — is exactly that, so it needs its own minting endpoint.
//
// Guardrail 1: `requireAdmin()` (admin + AAL2) is the first thing that happens.
// Guardrail 5: the BYTES never transit this server. We hand back signed
// direct-upload targets into the PRIVATE `post-media` bucket; the browser PUTs
// to them and then PATCHes the ordered path list back. Nothing is proxied and
// nothing is watermarked here.
//
// THE ROUTE NEVER ACCEPTS A CLIENT-SUPPLIED PATH. Every path is derived from
// the post id in `uploadSlotPath`, so a caller cannot aim an upload at another
// post's prefix (or anywhere else in the bucket) by asking nicely.

type PostRow = { id: string; type: string; media_url: string | null };

/**
 * Upper bound on the client's `afterSlot` hint. Slots are not display positions
 * and legitimately leave gaps (a removed photo's ordinal is never reused), so
 * the ceiling is well above MAX_PHOTOS — it exists only so a nonsense value
 * cannot mint `<postId>/photo-999999999`.
 */
const MAX_SLOT_HINT = 999;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const { id } = await params;
  // Shape-check before the query: a malformed id otherwise reaches Postgres and
  // comes back as an `invalid input syntax for type uuid` message we would echo.
  if (!isUuid(id)) return fail("not_found", "Post not found.", 404);

  const body = (await req.json().catch(() => null)) as {
    count?: unknown;
    afterSlot?: unknown;
    keeping?: unknown;
  } | null;
  const count = body?.count;
  // Whole numbers only, 1..10. `1.5` and `"2"` are client bugs, not requests to
  // round — minting a fractional number of slots is not a thing, and a string
  // would make the loop below iterate zero times and return an empty set that
  // the client would read as success.
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MAX_PHOTOS) {
    return fail(
      "validation_failed",
      `count must be a whole number from 1 to ${MAX_PHOTOS}.`,
      400,
    );
  }

  const { data } = await sb.from("post").select("id,type,media_url").eq("id", id).maybeSingle();
  const post = data as PostRow | null;
  if (!post) return fail("not_found", "Post not found.", 404);
  // 409, not 400: the request is well-formed, the post is simply the wrong kind
  // of thing to add photos to. Video is one Mux asset and voice one Storage
  // object, so a second slot on either would be an object nothing ever reads.
  if (post.type !== "photo") {
    return fail("not_photo_post", "Only a photo post can take more photos.", 409);
  }

  const { data: mediaRows } = await sb.from("post_media").select("media_url").eq("post_id", id);
  const rowPaths = ((mediaRows ?? []) as { media_url: string | null }[]).map((r) => r.media_url);

  // The objects already under this post's Storage prefix.
  //
  // READING STORAGE, not just `post_media`, is load-bearing and is a deliberate
  // departure from the ticket's sketch ("1 + the highest ordinal in the post's
  // post_media paths"). In the CREATE flow the strip's photos have been uploaded
  // but `post_media` is not written until Save, so a post_media-only derivation
  // answers "1" for a draft that already holds `photo-1` and `photo-2` — and the
  // appended upload would PUT straight over the operator's second photo. The
  // union of both sources is the only view that is monotonic in both modes.
  // `limit: 1000`, not Supabase's default of 100. The default is also
  // LEXICOGRAPHIC (`photo-1, photo-10, photo-100, …, photo-2`), and a removed
  // photo's object is never cleaned up (decision 5), so a long-lived post can
  // exceed 100 objects between its `original`/`photo-<n>` set and its
  // orphans. Past that limit `objectPaths` silently truncates and the slot
  // floor derived from it can REGRESS — re-minting a slot that already holds
  // bytes. 1000, not `MAX_PHOTOS` (10): this listing counts every ORPHAN ever
  // left behind too, not just the post's current, persisted set.
  const { data: objects, error: listError } = await sb.storage
    .from(POST_MEDIA_BUCKET)
    .list(id, { limit: 1000 });
  // FAIL CLOSED. The whole derivation below rests on this listing; if it is
  // missing we would silently fall back to the `post_media`-only answer, which
  // for a draft mid-compose is `1` — and that upload would land on top of the
  // operator's second photo. A 502 they can retry beats a photo they lose.
  if (listError) {
    return fail("storage_unavailable", listError.message ?? "Storage is unavailable.", 502);
  }
  const objectPaths = ((objects ?? []) as { name?: string }[])
    .map((o) => (o.name ? `${id}/${o.name}` : null))
    .filter((p): p is string => p !== null);

  // THE CAP is counted against what the operator will actually KEEP, which only
  // the browser knows.
  //
  // Counting objects or rows instead over-counts, because a removed photo's
  // bytes are deliberately left in Storage (decision 5, no cleanup) and its row
  // may still be there until the next save. That made the ticket's own headline
  // flow impossible: on a full 10-photo post, removing the wrong photo and
  // adding its replacement counts 10 + 1 and 400s. It also disagreed with the
  // client's own pre-check, so the operator got the cap sentence AFTER the
  // screen had already accepted the pick.
  //
  // Trusting a client integer is safe here because this cap is not the
  // boundary: `normaliseMediaSet` re-checks 1..10 on the save that actually
  // persists the set, and `post_media`'s CHECK bounds `sort_order` 0..9 in the
  // database. This is the EARLY, operator-facing message — exactly what
  // MAX_PHOTOS is documented to be.
  const keeping = body?.keeping;
  const keepingValid =
    typeof keeping === "number" && Number.isInteger(keeping) && keeping >= 0 && keeping <= MAX_PHOTOS;
  const currentCount = keepingValid ? keeping : Math.max(rowPaths.length, objectPaths.length);
  if (currentCount + count > MAX_PHOTOS) {
    return fail(
      "too_many_photos",
      `You can add up to ${MAX_PHOTOS} photos to a post — this would make ${currentCount + count}. Nothing was uploaded.`,
      400,
    );
  }

  // WHERE THE NEW SLOTS START.
  //
  // The server's own view — rows + mirror + objects — is monotonic only with
  // respect to uploads that have COMPLETED. It cannot see a slot that has been
  // minted but whose bytes are still in flight, or one whose upload failed and
  // is sitting in the strip behind a retry button. Both are reachable: the
  // screen deliberately allows an append while an earlier batch is uploading.
  //
  // Without the hint: append A of 2 mints photo-1 + photo-2, photo-1 lands, the
  // operator appends again, the listing shows only {original, photo-1} — and
  // photo-2 is minted a SECOND time, over a photo that is still uploading.
  //
  // `afterSlot` is the browser's highest held ordinal. It is a plain integer and
  // is only ever used to push the start FORWARD (`Math.max`), so a hostile or
  // stale value cannot make the route re-issue a live slot — the server's own
  // floor still applies. A silly-large value would only skip ordinals, but it is
  // bounded anyway so it cannot mint an absurd object name.
  const afterSlot = body?.afterSlot;
  const hinted =
    typeof afterSlot === "number" && Number.isInteger(afterSlot) && afterSlot >= 0 && afterSlot <= MAX_SLOT_HINT
      ? afterSlot + 1
      : 0;
  const start = Math.max(nextPhotoSlot([...rowPaths, post.media_url, ...objectPaths]), hinted);
  const uploads: {
    sortOrder: number;
    path: string;
    token: string;
    uploadUrl: string;
    bucket: string;
  }[] = [];
  for (let i = 0; i < count; i++) {
    const slot = start + i;
    const slotObject = uploadSlotPath(id, slot);
    const { data: signed, error } = await sb.storage
      .from(POST_MEDIA_BUCKET)
      .createSignedUploadUrl(slotObject);
    if (error || !signed) {
      // Partial sets are worse than none: the client would upload 2 of 3 and
      // show the operator a strip that silently lost a file they picked.
      return fail("storage_unavailable", error?.message ?? "Storage is unavailable.", 502);
    }
    uploads.push({
      // The upload SLOT, not the display position — reordering the strip never
      // moves bytes. Kept so the payload is the same shape `POST /posts`
      // returns and one client type covers both.
      sortOrder: slot,
      path: signed.path ?? slotObject,
      token: signed.token,
      uploadUrl: signed.signedUrl,
      bucket: POST_MEDIA_BUCKET,
    });
  }

  return ok({ uploads });
}
