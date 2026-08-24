import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";
import { createMuxDirectUpload, MuxError } from "@/lib/mux";
import { isLabelCheckViolation, LABEL_ERROR_MESSAGE, normalisePostLabel } from "@/lib/posts/labels";

const POST_MEDIA_BUCKET = "post-media"; // T15 private bucket (photo/voice)
// ENG-611: widened from video|photo. `post.type`'s CHECK has permitted all of
// these since the baseline schema, so nothing here needed a migration.
// `news` is deliberately EXCLUDED: it exists in the schema but nothing authors
// it, so this endpoint must keep rejecting it with a 400.
const CREATABLE_TYPES: string[] = ["video", "photo", "voice", "text"];

// 202 Accepted — the draft row exists, but the media upload is still pending:
// the client uploads the file bytes directly to Mux (video) / Storage (photo).
const accepted = (data: unknown) => NextResponse.json({ data }, { status: 202 });

// GET /api/admin/posts?status=&horseId=&q=  — review queue / library + search.
// Offset pagination; `q` is a free-text ILIKE over title/body plus the joined
// horse and trainer names (resolved BFF-side against the RLS admin client).
export async function GET(req: Request) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const u = new URL(req.url);
  const limit = Math.min(Number(u.searchParams.get("limit")) || 50, 100);
  const offset = Math.max(Number(u.searchParams.get("offset")) || 0, 0);

  let query = sb
    .from("post")
    .select(
      // `label` (ENG-745) is selected so the posts library can render the
      // category chip; that rendering is a later slice, this only carries it.
      "id,horse_id,type,status,title,body,label,like_count,published_at,scheduled_for,created_at,horse:horse_id(display_name,racing_name),trainer:source_trainer_id(name)",
      { count: "exact" },
    )
    .order("created_at", { ascending: false });

  const status = u.searchParams.get("status");
  if (status) query = query.eq("status", status);
  const horseId = u.searchParams.get("horseId");
  if (horseId) query = query.eq("horse_id", horseId);

  // Strip the characters that are structural in PostgREST's `.or()` grammar
  // (`,` separates clauses; `(` `)` group / delimit `.in(...)`) so a free-text
  // term can never produce a malformed filter (which would 400 the list). Other
  // punctuation (incl. `.`) is safe — it's part of the value after `col.ilike.`.
  const text = u.searchParams.get("q")?.replace(/[(),]/g, " ").trim();
  if (text) {
    const like = `%${text}%`;
    const ors = [`title.ilike.${like}`, `body.ilike.${like}`];
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
  const { horseId, type, title, body, sourceTrainerId, expiresAt, label } = payload ?? {};

  // A horse is required for EVERY type, text included: post.horse_id is NOT
  // NULL and it is what the member app renders in the byline.
  if (!horseId || !type || !sourceTrainerId)
    return fail("validation_failed", "horseId, type and sourceTrainerId are required.", 400);
  if (!CREATABLE_TYPES.includes(type))
    return fail(
      "validation_failed",
      "Only 'video', 'photo', 'voice' or 'text' posts can be created here.",
      400,
    );

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

  // Horse must exist — a clean 404 rather than a raw FK violation.
  const { data: horse } = await sb.from("horse").select("id").eq("id", horseId).maybeSingle();
  if (!horse) return fail("horse_not_found", "Horse not found.", 404);

  const { data: draft, error } = await sb
    .from("post")
    .insert({
      horse_id: horseId,
      type,
      title: title ?? null,
      body: hasBody ? body : null,
      source_trainer_id: sourceTrainerId,
      status: "draft",
      watermarked: false,
      expires_at: expiresAt ?? null,
      label: labelValue,
    })
    .select("id,status,type,horse_id,created_at,label")
    .single();
  // A `post_label_preset` violation is the operator sending a category this
  // build does not know about (a preset dropped by a later migration, say), not
  // a server fault — surface it as the same 400 the up-front check produces.
  // Matched by constraint NAME: a bare 23514 would also swallow `post`'s type /
  // status / aspect-ratio CHECKs and mislabel them as a category problem.
  if (isLabelCheckViolation(error))
    return fail("validation_failed", LABEL_ERROR_MESSAGE, 400);
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
  const objectPath = `${draft.id}/original`;
  const { data: signed, error: storageErr } = await sb.storage
    .from(POST_MEDIA_BUCKET)
    .createSignedUploadUrl(objectPath);
  if (storageErr || !signed) {
    await sb.from("post").delete().eq("id", draft.id).eq("status", "draft"); // roll back the orphan draft
    return fail("storage_unavailable", storageErr?.message ?? "Storage is unavailable.", 502);
  }
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
    uploadUrl: signed.signedUrl,
    path: signed.path ?? objectPath,
    token: signed.token,
    bucket: POST_MEDIA_BUCKET,
  });
}
