import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";
import { resolveVideoPlayback } from "@/lib/mux-playback";
import { subjectLabel } from "@/lib/posts/subject";

// GET /api/admin/posts/:id/preview — render data for the mobile + web preview
// frames shown in Compose (T6) before publishing. Returns { mobile, web }; the
// frames share the same normalized payload today. Video posts additionally
// carry `playbackUrl`, a short-lived signed HLS URL (reconciled from Mux on
// read when the webhook hasn't landed yet).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;
  const { id } = await params;

  const { data: post } = await sb
    .from("post")
    .select(
      "id,subject,byline,type,status,title,body,media_url,mux_playback_id,published_at,scheduled_for,expires_at,horse:horse_id(id,display_name,racing_name),trainer:source_trainer_id(id,name)",
    )
    .eq("id", id)
    .maybeSingle();
  if (!post) return fail("not_found", "Post not found.", 404);

  // Both embeds are nullable since B1 (ENG-1269): a trainer post has no horse
  // and a StablePass post has neither, so every read below goes through `?.`
  // and the head is named by `subjectLabel`, not by whichever embed came back.
  const horse = post.horse as { display_name?: string; racing_name?: string } | null;
  const trainer = post.trainer as { name?: string } | null;
  const subject = subjectLabel({
    subject: post.subject as string | null,
    horseName: horse?.racing_name ?? horse?.display_name,
    trainerName: trainer?.name,
    byline: post.byline as string | null,
  });

  const playback =
    post.type === "video"
      ? await resolveVideoPlayback(sb, { id: post.id, mux_playback_id: post.mux_playback_id })
      : { playbackId: post.mux_playback_id, playbackUrl: null };

  const frame = {
    id: post.id,
    type: post.type,
    status: post.status,
    title: post.title,
    body: post.body,
    mediaUrl: post.media_url,
    muxPlaybackId: playback.playbackId,
    playbackUrl: playback.playbackUrl,
    horseName: horse?.racing_name ?? horse?.display_name ?? null,
    // `byline` stays the TRAINER name for back-compat — it is what the compose
    // preview head has read since A3 — and the new `subject` block carries the
    // three-subject head (name / tag / detail) alongside it. Adding a field is
    // additive; repurposing this one would have silently changed what every
    // existing caller renders.
    byline: trainer?.name ?? null,
    subject: subject.subject,
    subjectName: subject.name,
    subjectTag: subject.tag,
    subjectDetail: subject.detail,
    subjectText: subject.text,
    publishedAt: post.published_at,
    scheduledFor: post.scheduled_for,
    expiresAt: post.expires_at,
  };

  return ok({ mobile: frame, web: frame });
}
