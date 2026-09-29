import { requireAdmin } from "@/lib/auth/admin";
import { ok, noContent, fail } from "@/lib/api/envelope";
import { isLabelCheckViolation, LABEL_ERROR_MESSAGE, normalisePostLabel } from "@/lib/posts/labels";
import {
  isMediaOrderViolation,
  isMissingMediaTable,
  MEDIA_ERROR_MESSAGE,
  normaliseMediaSet,
} from "@/lib/posts/media";
import {
  parseVideoOrder,
  loadPostVideos,
  cleanupVideos,
  isSlotConflict,
  isMissingVideoTable,
  type PostVideoRow,
} from "@/lib/posts/videos";

// camelCase request field → post column.
const FIELD_MAP: Record<string, string> = {
  title: "title",
  body: "body",
  type: "type",
  expiresAt: "expires_at",
  sourceTrainerId: "source_trainer_id",
  // ENG-745. `null` is meaningful here and distinct from absent: sending
  // `label: null` CLEARS the category, while omitting the key leaves whatever
  // is on the row untouched — which is what keeps an old unlabelled post
  // unlabelled when the operator saves an edit without opening the picker.
  label: "label",
  /**
   * ENG-1268 — the StablePass byline. Listed here so a byline-only save counts
   * as "the caller asked for something" below; the value it puts in the patch
   * is then REPLACED by the validated, trimmed name further down, and a
   * `byline` on a non-stablepass post never gets that far (400).
   */
  byline: "byline",
  // ENG-824 — poster frame time (seconds). Same snake_case on the wire as the
  // column. Absent leaves the row alone; a number sets it.
  poster_time_s: "poster_time_s",
};

// PATCH /api/admin/posts/:id — edit post fields (editable byline included).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;
  const { id } = await params;
  const b = await req.json().catch(() => ({}));

  /**
   * IMMUTABLE FIELDS (ENG-1268) — refused loudly, never silently ignored.
   *
   * `subject` is fixed at creation: a published trainer post cannot become a
   * horse post, because the asset, the byline and every member surface were
   * built around who it is from. `horseId` is the same fact by another name.
   * They are NOT in FIELD_MAP, so without this they would simply be dropped —
   * and a caller that sent `subject: "horse"` would get a cheerful 200 back
   * for a change that never happened. A 400 says what actually occurred.
   */
  for (const field of ["subject", "horseId", "horse_id"]) {
    if (field in b)
      return fail(
        "validation_failed",
        "Who a post is from can’t be changed after it is created.",
        400,
      );
  }

  const patch: Record<string, unknown> = {};
  for (const [field, column] of Object.entries(FIELD_MAP)) if (field in b) patch[column] = b[field];
  // `media` and `videos` are editable but are not `post` columns — they are
  // the whole `post_media` / `post_video` sets — so each counts toward "did
  // the caller ask for anything" on its own.
  if (Object.keys(patch).length === 0 && !("media" in b) && !("videos" in b))
    return fail("validation_failed", "No editable fields provided.", 400);

  /**
   * ENG-1597 — `videos`: the post's FULL ordered set of `post_video` row ids.
   * `knownVideos`, when sent, is the full set the client last loaded, so a
   * stale reorder (another admin added/removed a slot between load and save)
   * 409s instead of silently reordering a set the operator never saw.
   *
   * Parsed here (pure, no IO) so a malformed shape 400s before anything is
   * read or written — same discipline as every other validation in this file.
   */
  const wantsVideos = "videos" in b;
  const parsedVideos = wantsVideos ? parseVideoOrder(b.videos) : null;
  if (wantsVideos && parsedVideos === null)
    return fail("invalid_video_set", "Send the post's videos as 1 to 5 distinct ids.", 400);
  const wantsKnownVideos = "knownVideos" in b;
  if (
    wantsKnownVideos &&
    (!Array.isArray(b.knownVideos) || !b.knownVideos.every((v: unknown) => typeof v === "string"))
  )
    return fail("invalid_video_set", "Send the post's videos as 1 to 5 distinct ids.", 400);

  // Validate the category against the preset list before it reaches the CHECK,
  // so an off-list value gets a readable 400 instead of a raw constraint error.
  if ("label" in b) {
    const labelValue = normalisePostLabel(b.label);
    if (labelValue === undefined)
      return fail("validation_failed", LABEL_ERROR_MESSAGE, 400);
    patch.label = labelValue;
  }

  /**
   * ENG-1268 — `byline` and `sourceTrainerId` are both SUBJECT-DEPENDENT, so
   * this is the one place that has to read the post before deciding.
   *
   * Only fetched when one of the two is actually being set: a caption-only
   * save must not pay for a round-trip it does not need, and — more to the
   * point — must not be able to fail on one.
   *
   * The rules:
   *  - `byline`   → stablepass posts only, and the name must be a LIVE
   *                 `post_byline` row. A retired one is refused for the same
   *                 reason the create route refuses it: retiring withdraws a
   *                 name from NEW use while leaving it on every post that
   *                 already carries it (including this one, which is why the
   *                 picker shows it and why an unchanged save never sends it).
   *  - `sourceTrainerId` → horse posts only. A trainer post's trainer IS its
   *                 subject and is immutable; a stablepass post has none.
   */
  const wantsByline = "byline" in b;
  const wantsTrainer = "sourceTrainerId" in b;
  if (wantsByline || wantsTrainer) {
    const { data: existing, error: readErr } = await sb
      .from("post")
      .select("subject")
      .eq("id", id)
      .maybeSingle();
    if (readErr) {
      console.error("post query_failed", readErr.code);
      return fail("query_failed", "Could not load the post.", 400);
    }
    if (!existing) return fail("not_found", "Post not found.", 404);
    // A row predating B1's backfill reads as a horse post, which is what it is.
    const subject = existing.subject ?? "horse";

    if (wantsTrainer && subject !== "horse")
      return fail(
        "validation_failed",
        "The trainer byline can only be changed on a horse post.",
        400,
      );

    if (wantsByline) {
      if (subject !== "stablepass")
        return fail("validation_failed", "byline is only accepted for a stablepass post.", 400);
      if (typeof b.byline !== "string" || b.byline.trim() === "")
        return fail("validation_failed", "byline must be a non-empty name.", 400);
      const name = b.byline.trim();
      const { data: row, error: bylineErr } = await sb
        .from("post_byline")
        .select("name,retired_at")
        .eq("name", name)
        .maybeSingle();
      if (bylineErr) {
        console.error("post_byline query_failed", bylineErr.code);
        return fail("query_failed", "Could not check the byline.", 400);
      }
      if (!row || row.retired_at != null)
        return fail("unknown_byline", "That byline is not available. Pick another.", 400);
      patch.byline = name;
    }
  }

  // ENG-824 — reject non-finite / negative poster times (same rule as POST).
  if ("poster_time_s" in b) {
    const t = b.poster_time_s;
    if (t !== null && (typeof t !== "number" || !Number.isFinite(t) || t < 0)) {
      return fail("validation_failed", "poster_time_s must be a non-negative finite number.", 400);
    }
  }

  // ENG-748 — the ordered photo set, and the `post.media_url` mirror that keeps
  // every existing client working.
  //
  // ORDERING IS THE WHOLE DESIGN, because PostgREST gives us no transaction
  // across statements and ENG-740 deliberately ships no trigger.
  //
  // The `post` update runs FIRST, carrying the mirror alongside the field
  // edits, and `post_media` is only touched once it has succeeded. That is the
  // opposite of the obvious order, and it is deliberate: the realistic failure
  // here is the `post` update itself — the label CHECK backstop below, `type`
  // (which is in FIELD_MAP with no validation of its own), a bad `expiresAt`, a
  // deleted post, a transient error. Writing `post_media` first meant such a
  // failure returned 400 to the operator having ALREADY rewritten the ordered
  // rows, leaving `post_media` row 0 as the new cover while `post.media_url`
  // still pointed at the old one. Silent, durable divergence on a response that
  // said the save had failed — precisely the seam this ticket exists to protect.
  // Found in review; a probe forced a 22007 on the post update and reproduced it.
  //
  // With this order, that failure touches nothing: `post_media` is untouched, so
  // the previous set stays readable AND stays consistent with the unchanged
  // mirror. The remaining window is an upsert/trim failure AFTER a successful
  // post update, which leaves the mirror on the cover the operator actually
  // chose (a real, uploaded object) rather than a stale one — and because both
  // statements are idempotent, simply saving again converges.
  //
  // Contiguity and row-0 existence come from `normaliseMediaSet`, which assigns
  // ordinals from the array index instead of trusting the wire — ENG-740 asks
  // the writer for both and can express neither as a CHECK.
  let mediaRows: { sortOrder: number; mediaUrl: string }[] | null = null;
  if ("media" in b) {
    mediaRows = normaliseMediaSet(b.media, id);
    if (!mediaRows) return fail("validation_failed", MEDIA_ERROR_MESSAGE, 400);
    // THE COMPATIBILITY SEAM. Every existing reader — both front ends,
    // feed_page's `select p.*` — reads post.media_url and knows nothing about
    // post_media, so if this does not follow a reorder that changed position 0,
    // the feed and the member card show a different image than the admin
    // preview just promised, with no error anywhere to notice it by.
    patch.media_url = mediaRows[0].mediaUrl;
  }

  /**
   * ENG-1597 — the video-post pre-reads, all still BEFORE any write.
   *
   * `post.type` is only fetched when something actually needs it: a `videos`
   * edit (to 409 a non-video post) or a `poster_time_s` edit (to know whether
   * the slot-0 `post_video` row below even applies) — a caption-only save
   * must not pay for, or be able to fail on, a round trip it does not need.
   */
  const wantsPosterTime = "poster_time_s" in b;
  let videoPost: { id: string; type: string } | null = null;
  if (wantsVideos || wantsPosterTime) {
    const { data: p, error: postTypeErr } = await sb
      .from("post")
      .select("id,type")
      .eq("id", id)
      .maybeSingle();
    if (postTypeErr) {
      console.error("post query_failed", postTypeErr.code);
      return fail("query_failed", "Could not load the post.", 400);
    }
    if (!p) return fail("not_found", "Post not found.", 404);
    videoPost = p;
  }

  let currentVideoRows: PostVideoRow[] = [];
  if (wantsVideos) {
    if (videoPost!.type !== "video")
      return fail("not_video_post", "Videos can only be added to a video post.", 409);

    const { rows, error: videosErr } = await loadPostVideos(sb, id);
    if (videosErr) {
      console.error("post_video query_failed", videosErr.code);
      return fail("query_failed", "Could not check the post's videos.", 400);
    }
    currentVideoRows = rows;
    const currentIds = new Set(rows.map((r) => r.id));
    // Every id in the request must name a row THIS post already has —
    // `videos` reorders/removes the existing set, it never invents a slot
    // (that is what `POST .../video-uploads` is for).
    if (!parsedVideos!.every((v) => currentIds.has(v)))
      return fail("invalid_video_set", "Send the post's videos as 1 to 5 distinct ids.", 400);

    if (wantsKnownVideos) {
      const known = new Set(b.knownVideos as string[]);
      const same = known.size === currentIds.size && [...currentIds].every((v) => known.has(v));
      if (!same)
        return fail(
          "video_set_stale",
          "The post's videos changed. Refresh and try again.",
          409,
        );
    }
  }

  // Videos-ONLY request (no `media`, no other patch field): the `post` table
  // itself has nothing to write, so skip the update and read the row instead
  // — an empty `.update({})` is not a meaningful statement, and skipping it
  // means a videos-only save cannot trip a `post`-level CHECK it never
  // touched. `media` keeps the existing behaviour (an update call even when
  // `patch` is otherwise empty), since that path is unchanged by this ticket.
  const videosOnly = wantsVideos && !("media" in b) && Object.keys(patch).length === 0;
  const { data, error } = videosOnly
    ? await sb.from("post").select("*").eq("id", id).maybeSingle()
    : await sb.from("post").update(patch).eq("id", id).select("*").maybeSingle();
  // Backstop for a preset this build does not know about — same 400 as above,
  // never a 500 (guardrail: an editorial mistake is not a server fault).
  //
  // Scoped to the LABEL constraint by name, not to the bare 23514: `post` also
  // CHECKs `type`, `status` and `aspect_ratio`, and `type` is editable through
  // FIELD_MAP above with no validation of its own — so matching the code alone
  // reported every one of those as a label problem.
  if (isLabelCheckViolation(error))
    return fail("validation_failed", LABEL_ERROR_MESSAGE, 400);
  if (error) return fail("update_failed", error.message, 400);
  if (!data) return fail("not_found", "Post not found.", 404);

  // The ordered rows, now that `post` (and the mirror) are safely written.
  if (mediaRows) {
    const { error: upsertErr } = await sb.from("post_media").upsert(
      mediaRows.map((r) => ({ post_id: id, sort_order: r.sortOrder, media_url: r.mediaUrl })),
      { onConflict: "post_id,sort_order" },
    );

    // DEPLOY ORDER. `post_media` ships in stablepass-be (ENG-740) and the gate
    // sequences be-deploys-first — but if admin lands ahead of that migration,
    // this write hits a table that does not exist yet.
    //
    // A SINGLE-photo post needs no row here: `post.media_url` alone is exactly
    // what it rendered from before this ticket, and ENG-740's contract says a
    // post with zero post_media rows IS a complete single-photo post. So it
    // succeeds — this ticket must not make single-photo posting depend on a
    // migration it never needed.
    //
    // A MULTI-photo post cannot be stored as one, so it says so. The field
    // edits and the mirror have already landed by this point, which is the
    // better half of a bad situation: the post renders as a single photo
    // showing the cover the operator chose, rather than losing their caption.
    const missingTable = isMissingMediaTable(upsertErr);
    if (missingTable && mediaRows.length > 1)
      return fail(
        "media_unavailable",
        "The extra photos could not be saved: the post_media table is not deployed yet. The post kept its cover photo and your other edits. Deploy the stablepass-be migration, then re-save to add the rest.",
        503,
      );
    if (!missingTable) {
      // A duplicate ordinal or one outside 0..9 is an editorial/client mistake,
      // not a server fault — the same 400 the up-front normalise produces.
      if (isMediaOrderViolation(upsertErr))
        return fail("validation_failed", MEDIA_ERROR_MESSAGE, 400);
      if (upsertErr) return fail("update_failed", upsertErr.message, 400);

      // Shrink the set. Runs last because rows 0..n-1 and the mirror are
      // already correct by here, so a failure leaves stale TRAILING rows — a
      // head-consistent, self-healing state that the next save trims.
      const { error: trimErr } = await sb
        .from("post_media")
        .delete()
        .eq("post_id", id)
        .gte("sort_order", mediaRows.length);
      if (trimErr) return fail("update_failed", trimErr.message, 400);
    }
  }

  /**
   * ENG-1597 — the `post_video` writes, now that `post` is safely written.
   *
   * ORDER MATTERS, same reasoning as `post_media` above:
   *  a. delete removed rows FIRST — a slot freed here can never collide with
   *     the renumber in (b), which is the whole reason it goes first.
   *  b. renumber the KEPT rows in ONE upsert (on the `id` PK — the deferrable
   *     `(post_id, sort_order)` unique can never be an arbiter), so a swap
   *     between two rows passes the deferred constraint inside one statement.
   *  c. clear the NEW slot-0 row's poster frame if the cover actually changed
   *     — a new cover needs a new pick, so an old frame time is not carried
   *     over silently.
   *  d. best-effort Mux cleanup for whatever got removed, only after the
   *     delete in (a) has actually committed.
   */
  if (wantsVideos) {
    const keepIds = new Set(parsedVideos!);
    const toRemove = currentVideoRows.filter((r) => !keepIds.has(r.id));

    if (toRemove.length > 0) {
      const { error: removeErr } = await sb
        .from("post_video")
        .delete()
        .in("id", toRemove.map((r) => r.id))
        .eq("post_id", id);
      if (removeErr) {
        console.error("post_video update_failed", removeErr.code);
        return fail("update_failed", "Could not update the post's videos.", 400);
      }
    }

    const needsReorder = parsedVideos!.some((vid, i) => {
      const row = currentVideoRows.find((r) => r.id === vid);
      return !row || row.sort_order !== i;
    });
    if (needsReorder) {
      const { error: reorderErr } = await sb.from("post_video").upsert(
        parsedVideos!.map((vid, i) => ({ id: vid, post_id: id, sort_order: i })),
        { onConflict: "id" },
      );
      if (reorderErr) {
        if (isSlotConflict(reorderErr))
          return fail(
            "video_set_stale",
            "The post's videos changed. Refresh and try again.",
            409,
          );
        console.error("post_video update_failed", reorderErr.code);
        return fail("update_failed", "Could not update the post's videos.", 400);
      }
    }

    const currentSlot0Id = currentVideoRows.find((r) => r.sort_order === 0)?.id;
    if (parsedVideos![0] !== currentSlot0Id) {
      const { error: clearErr } = await sb
        .from("post_video")
        .update({ poster_time_s: null })
        .eq("id", parsedVideos![0])
        .eq("post_id", id);
      if (clearErr) {
        console.error("post_video update_failed", clearErr.code);
        return fail("update_failed", "Could not update the post's videos.", 400);
      }
    }

    await cleanupVideos(toRemove); // best-effort; never fails the request
  }

  /**
   * ENG-1597 — an explicit `poster_time_s` on a video post ALSO lands on the
   * slot-0 `post_video` row, AFTER the reorder/cover-clear above so an
   * explicit value in the SAME request wins over the clear in (c). Written
   * only to `post` it would be overwritten by the very trigger that mirrors
   * slot 0 onto `post` at commit — the next `post_video` write (a future
   * upload finishing, say) would silently revert it.
   *
   * Best-effort: this is bookkeeping for a value that already landed on
   * `post` itself, so a failure here is logged, never failed back to the
   * operator as though their save had not gone through.
   */
  if (wantsPosterTime && videoPost?.type === "video") {
    const slot0Id = wantsVideos
      ? parsedVideos![0]
      : (await loadPostVideos(sb, id)).rows.find((r) => r.sort_order === 0)?.id;
    if (slot0Id) {
      const { error: posterErr } = await sb
        .from("post_video")
        .update({ poster_time_s: patch.poster_time_s ?? null })
        .eq("id", slot0Id);
      if (posterErr && !isMissingVideoTable(posterErr))
        console.error("post_video update_failed", posterErr.code);
    }
  }

  return ok(data);
}

// DELETE /api/admin/posts/:id — discard a DRAFT only (hard delete). Published /
// scheduled / unpublished content is soft-hidden, never hard-deleted (guardrail §2).
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;
  const { id } = await params;

  const { data: post } = await sb.from("post").select("status").eq("id", id).maybeSingle();
  if (!post) return fail("not_found", "Post not found.", 404);
  if (post.status !== "draft")
    return fail("not_a_draft", "Only drafts can be discarded; published content is soft-hidden.", 409);

  // ENG-1597 — read the draft's video rows BEFORE deleting it, so there is
  // something to hand to Mux cleanup once the delete has actually committed.
  // Any read failure (including a not-yet-deployed table) is treated as "no
  // videos to clean up" — this is a best-effort courtesy, not a precondition.
  const { rows: videoRows } = await loadPostVideos(sb, id);

  // Scope the delete to draft too — defensive against a concurrent publish
  // landing between the check above and here (guardrail §2: never hard-delete a
  // published post).
  const { error } = await sb.from("post").delete().eq("id", id).eq("status", "draft");
  if (error) return fail("delete_failed", error.message, 400);
  await cleanupVideos(videoRows); // best-effort; the delete has already committed
  return noContent();
}
