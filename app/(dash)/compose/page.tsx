import { requireAdminPage } from "@/lib/auth/admin";
import ComposeScreen from "./ComposeScreen";
import type { EditInitial, HorseOption, MediaType, TrainerOption } from "./types";
import {
  HORSE_PHOTO_BUCKET,
  POST_MEDIA_BUCKET,
  signPhoto,
  signPhotoMap,
} from "@/lib/storage/photos";
import { resolveVideoPlayback } from "@/lib/mux-playback";

// The operator's core daily flow. The (dash) layout already gates the tree;
// we call requireAdminPage() again here for the elevated RLS client (`sb`) used
// to read the pickable horses + the full trainer list (Layer A `[PG] GET
// horse`/`trainer`) — reads that need the admin session, which lives in
// httpOnly cookies and is therefore only reachable from the server client.
//
// `?id=<postId>` opens Compose in EDIT mode: the post is loaded and hydrated
// (horse, caption, byline, media preview) — the row Edit action links here.
export const dynamic = "force-dynamic";

type HorseRow = {
  id: string;
  display_name: string | null;
  racing_name: string | null;
  photo_url: string | null;
  stable_name: string | null;
  trainer_id: string | null;
  trainer: { id: string; name: string | null; display_name: string | null } | Array<{
    id: string;
    name: string | null;
    display_name: string | null;
  }> | null;
};

type TrainerRow = { id: string; name: string | null; display_name: string | null };

type PostRow = {
  id: string;
  type: string;
  status: string;
  title: string | null;
  body: string | null;
  source_trainer_id: string;
  media_url: string | null;
  mux_playback_id: string | null;
  horse: HorseRow | HorseRow[] | null;
};

function one<T>(v: T | T[] | null): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

export default async function ComposePage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const { sb } = await requireAdminPage();
  const { id } = await searchParams;

  const [horsesRes, trainersRes] = await Promise.all([
    sb
      .from("horse")
      .select(
        "id,display_name,racing_name,photo_url,stable_name,trainer_id,trainer:trainer_id(id,name,display_name)",
      )
      .eq("status", "active")
      .order("display_name"),
    sb.from("trainer").select("id,name,display_name").order("name"),
  ]);

  const horses: HorseOption[] = ((horsesRes.data as HorseRow[] | null) ?? []).map((h) => {
    const t = one(h.trainer);
    return {
      id: h.id,
      name: h.racing_name ?? h.display_name ?? "Unnamed horse",
      photoUrl: h.photo_url,
      stableName: h.stable_name,
      trainerId: h.trainer_id ?? t?.id ?? null,
      trainerName: t?.name ?? t?.display_name ?? null,
    };
  });

  const trainers: TrainerOption[] = ((trainersRes.data as TrainerRow[] | null) ?? []).map((t) => ({
    id: t.id,
    name: t.name ?? t.display_name ?? "Unnamed trainer",
  }));

  // Private bucket: sign each pickable horse's photo path for display.
  const horsePhotos = await signPhotoMap(sb, HORSE_PHOTO_BUCKET, horses.map((h) => h.photoUrl));
  const signedHorses: HorseOption[] = horses.map((h) => ({
    ...h,
    photoUrl: h.photoUrl ? horsePhotos.get(h.photoUrl) ?? null : null,
  }));

  // Edit mode: load the post identified by ?id and hydrate the form. Only
  // video/photo posts are editable here (compose only handles those types).
  let initial: EditInitial | undefined;
  if (id) {
    const { data } = await sb
      .from("post")
      .select(
        "id,type,status,title,body,source_trainer_id,media_url,mux_playback_id,horse:horse_id(id,display_name,racing_name,photo_url,stable_name,trainer_id,trainer:trainer_id(id,name,display_name))",
      )
      .eq("id", id)
      .maybeSingle();
    const post = data as PostRow | null;
    if (post && (post.type === "photo" || post.type === "video")) {
      const h = one(post.horse);
      const t = h ? one(h.trainer) : null;
      // Photo → signed Storage URL; video → signed Mux HLS URL (reconciled
      // from Mux on read if the webhook hasn't set mux_playback_id yet).
      const [horsePhoto, mediaUrl] = await Promise.all([
        signPhoto(sb, HORSE_PHOTO_BUCKET, h?.photo_url ?? null),
        post.type === "photo"
          ? signPhoto(sb, POST_MEDIA_BUCKET, post.media_url)
          : resolveVideoPlayback(sb, { id: post.id, mux_playback_id: post.mux_playback_id }).then(
              (p) => p.playbackUrl,
            ),
      ]);
      initial = {
        id: post.id,
        status: post.status,
        mediaType: post.type as MediaType,
        mediaUrl,
        title: post.title ?? "",
        caption: post.body ?? "",
        bylineId: post.source_trainer_id,
        horse: {
          id: h?.id ?? "",
          name: h?.racing_name ?? h?.display_name ?? "Unnamed horse",
          photoUrl: horsePhoto,
          stableName: h?.stable_name ?? null,
          trainerId: h?.trainer_id ?? t?.id ?? null,
          trainerName: t?.name ?? t?.display_name ?? null,
        },
      };
    }
  }

  return <ComposeScreen horses={signedHorses} trainers={trainers} initial={initial} />;
}
