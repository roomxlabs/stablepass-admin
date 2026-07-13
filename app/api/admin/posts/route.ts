import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";
import { createMuxDirectUpload, MuxError } from "@/lib/mux";

const POST_MEDIA_BUCKET = "post-media"; // T15 private bucket (photo/voice)
const CREATABLE_TYPES: string[] = ["video", "photo"]; // this endpoint creates video|photo only

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
      "id,horse_id,type,status,title,body,like_count,published_at,scheduled_for,created_at,horse:horse_id(display_name,racing_name),trainer:source_trainer_id(name)",
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
// target**: video → Mux direct upload, photo → Supabase Storage signed upload
// URL. The finished file bytes never transit our server (guardrail §5). No
// watermark mutation. video|photo only (text/voice/news creation is out of scope).
export async function POST(req: Request) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const body = await req.json().catch(() => ({}));
  const { horseId, type, title, sourceTrainerId, expiresAt } = body ?? {};

  if (!horseId || !type || !sourceTrainerId)
    return fail("validation_failed", "horseId, type and sourceTrainerId are required.", 400);
  if (!CREATABLE_TYPES.includes(type))
    return fail("validation_failed", "Only 'video' or 'photo' posts can be created here.", 400);

  // Horse must exist — a clean 404 rather than a raw FK violation.
  const { data: horse } = await sb.from("horse").select("id").eq("id", horseId).maybeSingle();
  if (!horse) return fail("horse_not_found", "Horse not found.", 404);

  const { data: draft, error } = await sb
    .from("post")
    .insert({
      horse_id: horseId,
      type,
      title: title ?? null,
      source_trainer_id: sourceTrainerId,
      status: "draft",
      watermarked: false,
      expires_at: expiresAt ?? null,
    })
    .select("id,status,type,horse_id,created_at")
    .single();
  if (error || !draft) return fail("insert_failed", error?.message ?? "Could not create draft.", 400);

  if (type === "video") {
    try {
      // passthrough = post id: Mux echoes it on asset webhooks so the BE
      // mux-webhook (and our read-time fallback) can reconcile the processed
      // asset back onto this post.
      const { uploadId, uploadUrl } = await createMuxDirectUpload({ passthrough: draft.id });
      return accepted({ id: draft.id, status: "draft", type, watermarked: false, uploadUrl, muxUploadId: uploadId });
    } catch (e) {
      await sb.from("post").delete().eq("id", draft.id); // roll back the orphan draft
      const msg = e instanceof MuxError ? e.message : "Mux is unavailable.";
      return fail("mux_unavailable", msg, 502);
    }
  }

  // photo → Supabase Storage direct-upload target (signed upload URL).
  const objectPath = `${draft.id}/original`;
  const { data: signed, error: storageErr } = await sb.storage
    .from(POST_MEDIA_BUCKET)
    .createSignedUploadUrl(objectPath);
  if (storageErr || !signed) {
    await sb.from("post").delete().eq("id", draft.id); // roll back the orphan draft
    return fail("storage_unavailable", storageErr?.message ?? "Storage is unavailable.", 502);
  }
  // Record where the media will land; the bytes go direct to Storage.
  await sb.from("post").update({ media_url: objectPath }).eq("id", draft.id);
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
