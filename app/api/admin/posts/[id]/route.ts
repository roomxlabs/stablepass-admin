import { requireAdmin } from "@/lib/auth/admin";
import { ok, noContent, fail } from "@/lib/api/envelope";
import { isLabelCheckViolation, LABEL_ERROR_MESSAGE, normalisePostLabel } from "@/lib/posts/labels";
import {
  isMediaOrderViolation,
  isMissingMediaTable,
  MEDIA_ERROR_MESSAGE,
  normaliseMediaSet,
} from "@/lib/posts/media";

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

  const patch: Record<string, unknown> = {};
  for (const [field, column] of Object.entries(FIELD_MAP)) if (field in b) patch[column] = b[field];
  // `media` is editable but is not a `post` column — it is the whole `post_media`
  // set — so it counts toward "did the caller ask for anything" on its own.
  if (Object.keys(patch).length === 0 && !("media" in b))
    return fail("validation_failed", "No editable fields provided.", 400);

  // Validate the category against the preset list before it reaches the CHECK,
  // so an off-list value gets a readable 400 instead of a raw constraint error.
  if ("label" in b) {
    const labelValue = normalisePostLabel(b.label);
    if (labelValue === undefined)
      return fail("validation_failed", LABEL_ERROR_MESSAGE, 400);
    patch.label = labelValue;
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

  const { data, error } = await sb.from("post").update(patch).eq("id", id).select("*").maybeSingle();
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

  // Scope the delete to draft too — defensive against a concurrent publish
  // landing between the check above and here (guardrail §2: never hard-delete a
  // published post).
  const { error } = await sb.from("post").delete().eq("id", id).eq("status", "draft");
  if (error) return fail("delete_failed", error.message, 400);
  return noContent();
}
