import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";
import { createMuxDirectUpload, MuxError } from "@/lib/mux";
import {
  CHECK_VIOLATION,
  isLabelCheckViolation,
  LABEL_ERROR_MESSAGE,
  normalisePostLabel,
} from "@/lib/posts/labels";
import { isSubject, SUBJECTS } from "@/lib/posts/subject";
import { MAX_PHOTOS, uploadSlotPath } from "@/lib/posts/media";
import { isUuid } from "@/lib/uuid";
import {
  POSTS_API_SELECT,
  POST_SORT_DEFAULT_DIR,
  parsePostSort,
  postsOrder,
  postsSelect,
} from "@/lib/posts/sort";

const POST_MEDIA_BUCKET = "post-media"; // T15 private bucket (photo/voice)
// ENG-611: widened from video|photo. `post.type`'s CHECK has permitted all of
// these since the baseline schema, so nothing here needed a migration.
// `news` is deliberately EXCLUDED: it exists in the schema but nothing authors
// it, so this endpoint must keep rejecting it with a 400.
const CREATABLE_TYPES: string[] = ["video", "photo", "voice", "text"];

/** ENG-1268, epic decision 2 — the only two types a StablePass post may be. */
const STABLEPASS_TYPES: string[] = ["photo", "video"];

/** B1's CHECK re-stating the per-subject required/forbidden columns. */
const SUBJECT_CONSTRAINT = "post_subject";

/**
 * B1's subject-shape CHECK — the database's own backstop for the validation
 * block at the top of POST.
 *
 * MATCHED BY CONSTRAINT NAME, never on the bare 23514, for exactly the reason
 * `isLabelCheckViolation` spells out: `post` also CHECKs `type`, `status`,
 * `aspect_ratio` and the label preset, and a bare code turns every one of them
 * into "that combination of subject fields is not allowed" — a worse error
 * than the raw constraint message it replaced, and one that would hide a real
 * bug behind a plausible-looking 400.
 *
 * (An earlier draft of this ticket did match the bare code, and placed the
 * branch ABOVE the label one, which silently captured `post_label_preset` and
 * `post_aspect_ratio_positive` both. Two pre-existing tests caught it. The
 * prefix match is deliberately loose — `post_subject` rather than the full
 * `post_subject_shape` — so a be migration that renames the constraint to
 * `post_subject_shape_v2` still lands here rather than as a 500.)
 */
function isSubjectCheckViolation(
  error: { code?: string; message?: string; details?: string } | null,
): boolean {
  if (error?.code !== CHECK_VIOLATION) return false;
  return `${error?.message ?? ""} ${error?.details ?? ""}`.includes(SUBJECT_CONSTRAINT);
}

// 202 Accepted — the draft row exists, but the media upload is still pending:
// the client uploads the file bytes directly to Mux (video) / Storage (photo).
const accepted = (data: unknown) => NextResponse.json({ data }, { status: 202 });

// GET /api/admin/posts?status=&horseId=&trainerId=&q=&sort=&dir=
//   — review queue / library + search.
// Offset pagination; `q` is a free-text ILIKE over title/body plus the joined
// horse and trainer names (resolved BFF-side against the RLS admin client).
//
// `sort`/`dir` (ENG-963) are applied as `.order()` on the QUERY, before
// `.range()`. That ordering is the whole point: this endpoint is
// offset-paginated, so sorting the returned page instead would reorder 50 rows
// out of the wrong 50. `sort` shares its mapping with the Posts screen
// (lib/posts/sort.ts) so the URL means the same thing in both.
// An unknown `sort` falls back to the default `created_at desc` rather than
// 400-ing — a stale bookmark should show the library, not an error.
export async function GET(req: Request) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const u = new URL(req.url);
  const limit = Math.min(Number(u.searchParams.get("limit")) || 50, 100);
  const offset = Math.max(Number(u.searchParams.get("offset")) || 0, 0);

  const sort = parsePostSort(u.searchParams.get("sort"));
  const rawDir = u.searchParams.get("dir");
  const dir =
    rawDir === "asc" || rawDir === "desc" ? rawDir : sort ? POST_SORT_DEFAULT_DIR[sort] : "desc";

  let query = sb
    .from("post")
    .select(
      // `postsSelect` makes the horse embed `!inner` for the horse-name sort
      // only — PostgREST will not order parent rows by an embedded column
      // otherwise. Every other sort gets this string unchanged.
      postsSelect(POSTS_API_SELECT, sort),
      { count: "exact" },
    );
  for (const o of postsOrder(sort, dir)) {
    query = query.order(o.column, {
      ascending: o.ascending,
      ...(o.nullsFirst === undefined ? {} : { nullsFirst: o.nullsFirst }),
    });
  }

  const status = u.searchParams.get("status");
  if (status) query = query.eq("status", status);
  const horseId = u.searchParams.get("horseId");
  if (horseId) query = query.eq("horse_id", horseId);
  // ENG-963 — scope the library to one trainer's posts, the counterpart of the
  // Horses list's `?trainerId=`. Filters `post.source_trainer_id` (the byline),
  // NOT the horse's trainer: the two differ whenever a post is bylined to
  // someone other than the horse's own trainer, and the Trainers list's counts
  // are byline-based, so filtering the other way would make the count and the
  // list it opens disagree.
  // Shape-checked like the screen does it: a non-uuid would otherwise reach
  // Postgres, 400, and get echoed back through `fail("query_failed",
  // error.message)` — leaking a schema detail for what is only ever a stale
  // link. Ignored rather than rejected, so a bad bookmark shows the library.
  const trainerId = u.searchParams.get("trainerId");
  if (isUuid(trainerId))
    query = query.eq("source_trainer_id", trainerId);

  // Strip the characters that are structural in PostgREST's `.or()` grammar
  // (`,` separates clauses; `(` `)` group / delimit `.in(...)`) so a free-text
  // term can never produce a malformed filter (which would 400 the list). Other
  // punctuation (incl. `.`) is safe — it's part of the value after `col.ilike.`.
  const text = u.searchParams.get("q")?.replace(/[(),]/g, " ").trim();
  if (text) {
    const like = `%${text}%`;
    // ENG-1269 — `byline` joins title/body as a post-level text column. A
    // StablePass post has no horse and no trainer to match on, so without this
    // the ONLY way to find one by name is to page through the whole library.
    const ors = [`title.ilike.${like}`, `body.ilike.${like}`, `byline.ilike.${like}`];
    // Extend the search across joined horse / trainer names by resolving the
    // matching ids first, then folding them into the post-level OR.
    const [{ data: horses }, { data: trainers }] = await Promise.all([
      sb
        .from("horse")
        .select("id")
        .or(`display_name.ilike.${like},racing_name.ilike.${like},stable_name.ilike.${like}`),
      sb.from("trainer").select("id").or(`name.ilike.${like},display_name.ilike.${like}`),
    ]);
    const horseIds = (horses ?? []).map((h: { id: string }) => h.id);
    const trainerIds = (trainers ?? []).map((t: { id: string }) => t.id);
    if (horseIds.length) ors.push(`horse_id.in.(${horseIds.join(",")})`);
    if (trainerIds.length) ors.push(`source_trainer_id.in.(${trainerIds.join(",")})`);
    query = query.or(ors.join(","));
  }

  const { data, count, error } = await query.range(offset, offset + limit - 1);
  if (error) return fail("query_failed", error.message, 400);
  const rows = data ?? [];
  const total = count ?? rows.length;
  return ok(rows, { limit, offset, count: total, hasMore: offset + rows.length < total });
}

// POST /api/admin/posts — create a draft, then hand back a **direct upload
// target**: video → Mux direct upload, photo AND voice → Supabase Storage
// signed upload URL. The finished file bytes never transit our server
// (guardrail §5). No watermark mutation.
//
// `text` (ENG-611) is the odd one out: it carries no asset, so it gets NO
// upload target at all — a 202 with just the draft. It must not touch Storage
// or Mux, and must not roll its draft back for the absence of an upload
// target it was never supposed to have.
//
// `news` remains uncreatable here.
export async function POST(req: Request) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const payload = await req.json().catch(() => ({}));
  const {
    horseId,
    type,
    title,
    body,
    sourceTrainerId,
    expiresAt,
    label,
    photoCount,
    poster_time_s,
    byline,
  } = payload ?? {};

  // -------------------------------------------------------------------------
  // SUBJECT VALIDATION (ENG-1268) — and it runs HERE, before the horse lookup
  // and long before any Storage or Mux call.
  //
  // THAT ORDER IS THE REQUIREMENT, not an optimisation. Every path below this
  // block that fails after minting an upload target has to roll the draft back
  // by hand, and a Mux direct upload or a signed Storage URL handed out for a
  // request we were always going to reject is an ORPHAN UPLOAD TARGET: the
  // client can still PUT bytes to it, and those bytes land against a post that
  // does not exist. So a malformed subject must be a 400 that has touched
  // nothing. `route.test.ts` asserts `state.calls.storage` AND the Mux mock are
  // EMPTY for every 400 in this matrix, which is what keeps it that way.
  // -------------------------------------------------------------------------

  // Absent → `horse`. BACK-COMPAT: every caller that predates this ticket
  // sends no `subject` key at all, and must keep behaving exactly as it did.
  const subject = payload?.subject ?? "horse";
  if (!isSubject(subject))
    return fail("validation_failed", `subject must be one of ${SUBJECTS.join(", ")}.`, 400);

  if (!type) return fail("validation_failed", "type is required.", 400);
  if (!CREATABLE_TYPES.includes(type))
    return fail(
      "validation_failed",
      "Only 'video', 'photo', 'voice' or 'text' posts can be created here.",
      400,
    );

  // Each subject's required fields AND its forbidden ones. Both halves matter:
  // a trainer post carrying a `horseId` is not a harmless extra — it would
  // write a horse onto a post whose whole point is that it has none, and the
  // member feed would head it with that horse.
  if (subject === "horse") {
    if (!horseId || !sourceTrainerId)
      return fail(
        "validation_failed",
        "horseId and sourceTrainerId are required for a horse post.",
        400,
      );
    if (byline !== undefined && byline !== null)
      return fail("validation_failed", "byline is only accepted for a stablepass post.", 400);
  } else if (subject === "trainer") {
    if (!sourceTrainerId)
      return fail("validation_failed", "sourceTrainerId is required for a trainer post.", 400);
    if (horseId)
      return fail("validation_failed", "A trainer post cannot carry a horseId.", 400);
    if (byline !== undefined && byline !== null)
      return fail("validation_failed", "byline is only accepted for a stablepass post.", 400);
  } else {
    // stablepass
    if (horseId || sourceTrainerId)
      return fail(
        "validation_failed",
        "A stablepass post cannot carry a horseId or a sourceTrainerId.",
        400,
      );
    if (typeof byline !== "string" || byline.trim() === "")
      return fail("validation_failed", "byline is required for a stablepass post.", 400);
    // Epic decision 2. Enforced server-side as well as hidden in the picker,
    // because the BFF is not the only caller of this endpoint.
    if (!STABLEPASS_TYPES.includes(type))
      return fail(
        "validation_failed",
        "A stablepass post must be a photo or a video.",
        400,
      );
  }

  // A text post's body IS the post — a title alone is not one. Enforced here
  // as well as in Compose, because the BFF is not the only caller.
  const hasBody = typeof body === "string" && body.trim().length > 0;
  if (type === "text" && !hasBody)
    return fail("validation_failed", "A text post requires a non-empty body.", 400);

  // `label` is optional and nullable (ENG-745). Absent or null → no label, which
  // is what every post created before 2026-08-19 has and what renders no pill.
  // An off-list value is rejected HERE with a readable message rather than being
  // left to the CHECK, but the 23514 mapping below still stands as the backstop.
  const labelValue = "label" in (payload ?? {}) ? normalisePostLabel(label) : null;
  if (labelValue === undefined)
    return fail("validation_failed", LABEL_ERROR_MESSAGE, 400);

  // ENG-748 — how many direct-upload targets to mint. PHOTO ONLY: video is a
  // single Mux asset and voice a single Storage object (ENG-740 decision 3), so
  // asking for two of either is a client bug and gets a 400 rather than a
  // second target that nothing would ever read.
  //
  // Absent → 1, which is what every caller predating this ticket sends and what
  // keeps the single-photo path byte-identical. The bound is validated here
  // because the count decides how many Storage round-trips we make BEFORE any
  // row exists to constrain it — the table's 0..9 CHECK cannot reject a request
  // that has not written a row yet.
  const wantsPhotos = photoCount === undefined || photoCount === null ? 1 : photoCount;
  if (
    !Number.isInteger(wantsPhotos) ||
    wantsPhotos < 1 ||
    wantsPhotos > MAX_PHOTOS ||
    (wantsPhotos > 1 && type !== "photo")
  )
    return fail(
      "validation_failed",
      `photoCount must be a whole number from 1 to ${MAX_PHOTOS}, and only a photo post may exceed 1.`,
      400,
    );

  // Horse must exist — a clean 404 rather than a raw FK violation. Horse
  // subject only: the other two have no `horseId` to look up (the block above
  // already rejected one that was sent anyway).
  if (subject === "horse") {
    const { data: horse } = await sb.from("horse").select("id").eq("id", horseId).maybeSingle();
    if (!horse) return fail("horse_not_found", "Horse not found.", 404);
  }

  /**
   * The byline must name a LIVE `post_byline` row (ENG-1268).
   *
   * `post.byline` is FK'd to `post_byline(name)`, so an unknown name would be
   * a 23503 at insert — but a RETIRED one would NOT: the row still exists, it
   * is only hidden from the picker. Both must be refused here, and they are
   * refused with the SAME code, because to the operator they are one fact:
   * that byline is not available for a new post.
   *
   * Checked BEFORE the insert and therefore before any upload target, like
   * everything else in this handler — the whole point of the ordering above.
   * The race the ticket names (another admin retires it between the picker's
   * read and this submit) lands here and 400s, which is exactly right.
   */
  let bylineName: string | null = null;
  if (subject === "stablepass") {
    bylineName = String(byline).trim();
    const { data: row, error: bylineErr } = await sb
      .from("post_byline")
      .select("name,retired_at")
      .eq("name", bylineName)
      .maybeSingle();
    // Never echo a Postgres message — log the code only (repo convention).
    if (bylineErr) {
      console.error("post_byline query_failed", bylineErr.code);
      return fail("query_failed", "Could not check the byline.", 400);
    }
    if (!row || row.retired_at != null)
      return fail("unknown_byline", "That byline is not available. Pick another.", 400);
  }

  // ENG-824 — optional poster frame time (seconds). Video only; ignore for
  // other types so a mis-sent key cannot land on a photo/text/voice row.
  // Absent / null → leave column null (Mux default bake). Non-finite rejected.
  let posterTime: number | null = null;
  if (poster_time_s !== undefined && poster_time_s !== null) {
    if (typeof poster_time_s !== "number" || !Number.isFinite(poster_time_s) || poster_time_s < 0) {
      return fail("validation_failed", "poster_time_s must be a non-negative finite number.", 400);
    }
    if (type === "video") posterTime = poster_time_s;
  }

  const { data: draft, error } = await sb
    .from("post")
    .insert({
      // EXPLICIT NULLS, never an omitted key (ENG-1268). `horse_id` and
      // `source_trainer_id` are nullable as of B1, and writing them out means
      // the inserted row is fully determined by the subject above rather than
      // by whatever the column defaults happen to be — which is what
      // `route.test.ts` pins with `toEqual`.
      horse_id: subject === "horse" ? horseId : null,
      source_trainer_id: subject === "stablepass" ? null : sourceTrainerId,
      subject,
      byline: bylineName,
      type,
      title: title ?? null,
      body: hasBody ? body : null,
      status: "draft",
      watermarked: false,
      expires_at: expiresAt ?? null,
      label: labelValue,
      ...(posterTime !== null ? { poster_time_s: posterTime } : {}),
    })
    .select("id,status,type,horse_id,created_at,label,subject,byline")
    .single();
  // B1 ships `post_subject_shape`, a CHECK that re-states the per-subject
  // required/forbidden columns in the database. The block at the top of this
  // handler is what an operator actually hits; this maps the backstop to the
  // same 400 with a generic message, so a skew between this build's rules and
  // the database's is an editorial error rather than a 500.
  // A `post_label_preset` violation is the operator sending a category this
  // build does not know about (a preset dropped by a later migration, say), not
  // a server fault — surface it as the same 400 the up-front check produces.
  // Matched by constraint NAME: a bare 23514 would also swallow `post`'s type /
  // status / aspect-ratio CHECKs and mislabel them as a category problem.
  if (isLabelCheckViolation(error))
    return fail("validation_failed", LABEL_ERROR_MESSAGE, 400);
  // AFTER the label branch, and scoped to its own constraint name. Both facts
  // matter: this is the backstop for the per-subject block at the top of the
  // handler, so a skew between this build's rules and the database's is an
  // editorial 400 rather than a 500 — but it must not swallow the label,
  // type, status or aspect-ratio CHECKs on the way past.
  if (isSubjectCheckViolation(error))
    return fail("validation_failed", "That combination of subject fields is not allowed.", 400);
  if (error || !draft) return fail("insert_failed", error?.message ?? "Could not create draft.", 400);

  // text → done. No upload target, so no Storage/Mux call to make and nothing
  // to roll the draft back for.
  if (type === "text") {
    return accepted({ id: draft.id, status: "draft", type, watermarked: false });
  }

  if (type === "video") {
    try {
      // passthrough = post id: Mux echoes it on asset webhooks so the BE
      // mux-webhook (and our read-time fallback) can reconcile the processed
      // asset back onto this post.
      const { uploadId, uploadUrl } = await createMuxDirectUpload({ passthrough: draft.id });
      return accepted({ id: draft.id, status: "draft", type, watermarked: false, uploadUrl, muxUploadId: uploadId });
    } catch (e) {
      await sb.from("post").delete().eq("id", draft.id).eq("status", "draft"); // roll back the orphan draft
      const msg = e instanceof MuxError ? e.message : "Mux is unavailable.";
      return fail("mux_unavailable", msg, 502);
    }
  }

  // photo | voice → Supabase Storage direct-upload target (signed upload URL).
  // Voice reuses the photo path EXACTLY: same private bucket, same
  // `<postId>/original` object, no new bucket and no Mux. There is no duration
  // column on `post`, so nothing here records one.
  //
  // ENG-748: `wantsPhotos` targets, one per upload SLOT. Slot 0 keeps
  // `<postId>/original`, so a single-photo post produces exactly the request it
  // always did; extras take `<postId>/photo-<n>` per ENG-740's convention. The
  // slot is the UPLOAD ordinal and is NOT the display position — reordering the
  // strip never moves bytes, it only changes which path `post_media` row 0 (and
  // therefore the mirror) points at.
  const objectPath = uploadSlotPath(draft.id, 0);
  const uploads: { sortOrder: number; path: string; token: string; uploadUrl: string; bucket: string }[] = [];
  for (let slot = 0; slot < wantsPhotos; slot++) {
    const slotObject = uploadSlotPath(draft.id, slot);
    const { data: s, error: e } = await sb.storage
      .from(POST_MEDIA_BUCKET)
      .createSignedUploadUrl(slotObject);
    if (e || !s) {
      // Roll the whole draft back rather than hand back a partial set. A client
      // holding 3 of 5 targets would upload three objects against a post it then
      // has to reconcile, and the operator would see a strip that silently lost
      // two of the files they picked.
      await sb.from("post").delete().eq("id", draft.id).eq("status", "draft");
      return fail("storage_unavailable", e?.message ?? "Storage is unavailable.", 502);
    }
    uploads.push({
      sortOrder: slot,
      path: s.path ?? slotObject,
      token: s.token,
      uploadUrl: s.signedUrl,
      bucket: POST_MEDIA_BUCKET,
    });
  }
  const signed = uploads[0];
  // Record where the media will land; the bytes go direct to Storage.
  //
  // Checked, not fire-and-forget: if this write is lost the client still gets a
  // 202 and a valid upload target, so the bytes land in Storage against a post
  // whose media_url is permanently NULL — an orphaned object and a post that
  // renders blank forever. Roll the draft back instead, exactly as a failed
  // signing does.
  const { error: recordErr } = await sb
    .from("post")
    .update({ media_url: objectPath })
    .eq("id", draft.id);
  if (recordErr) {
    await sb.from("post").delete().eq("id", draft.id).eq("status", "draft");
    return fail("storage_unavailable", recordErr.message, 502);
  }
  return accepted({
    id: draft.id,
    status: "draft",
    type,
    watermarked: false,
    // Slot 0 stays at the TOP LEVEL, unchanged, so every existing caller and
    // test keeps reading the same four fields for a single-photo post. `uploads`
    // is purely additive and carries the same slot 0 as its first entry.
    uploadUrl: signed.uploadUrl,
    path: signed.path,
    token: signed.token,
    bucket: POST_MEDIA_BUCKET,
    uploads,
  });
}
