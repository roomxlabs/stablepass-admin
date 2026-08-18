import { requireAdminPage } from "@/lib/auth/admin";
import ComposeScreen from "./ComposeScreen";
import type { EditInitial, HorseOption, MediaType, TrainerOption } from "./types";
import { aestToday } from "./types";
import {
  loadRacingHorseIds,
  one,
  toHorseOptions,
  toTrainerOptions,
  type HorseRow,
  type RaceQueryClient,
  type TrainerRow,
} from "./data";
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

type PostRow = {
  id: string;
  type: string;
  status: string;
  title: string | null;
  body: string | null;
  source_trainer_id: string;
  scheduled_for: string | null;
  media_url: string | null;
  mux_playback_id: string | null;
  horse: HorseRow | HorseRow[] | null;
};

export default async function ComposePage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const { sb } = await requireAdminPage();
  const { id } = await searchParams;

  // Which horses actually run today, so the preview's "Race day" badge is real
  // rather than hardcoded on every post (ENG-558). `race_date` is a plain DATE
  // column, so it is a straight equality against today in AEST — both
  // 'upcoming' and 'finished' races count: a horse that ran this morning still
  // had a race day.
  //
  // The read lives in `loadRacingHorseIds` (data.ts), NOT inline: this file is
  // an async server component and cannot be unit-tested, and inline it let three
  // separate badge regressions pass the entire suite. That function owns the
  // `race_date` filter and the "a failed read is not 'nobody races today'"
  // branch, and data.test.ts pins both.
  const [horsesRes, trainersRes, racing] = await Promise.all([
    sb
      .from("horse")
      .select(
        "id,display_name,racing_name,photo_url,stable_name,trainer_id,trainer:trainer_id(id,name,display_name)",
      )
      .eq("status", "active")
      .order("display_name"),
    sb.from("trainer").select("id,name,display_name").order("name"),
    // Cast through unknown, same reason as lib/dashboard/queries.ts: with no
    // generated DB types, matching supabase-js's builder generics against a
    // hand-written structural type makes tsc unroll them (TS2589).
    loadRacingHorseIds(sb as unknown as RaceQueryClient, aestToday()),
  ]);

  const racingToday = racing.ids;

  const horses: HorseOption[] = toHorseOptions(horsesRes.data as HorseRow[] | null, racingToday);
  const trainers: TrainerOption[] = toTrainerOptions(trainersRes.data as TrainerRow[] | null);

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
        "id,type,status,title,body,source_trainer_id,scheduled_for,media_url,mux_playback_id,horse:horse_id(id,display_name,racing_name,photo_url,stable_name,trainer_id,trainer:trainer_id(id,name,display_name))",
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
        scheduledFor: post.scheduled_for,
        horse: {
          id: h?.id ?? "",
          name: h?.racing_name ?? h?.display_name ?? "Unnamed horse",
          photoUrl: horsePhoto,
          stableName: h?.stable_name ?? null,
          trainerId: h?.trainer_id ?? t?.id ?? null,
          trainerName: t?.name ?? t?.display_name ?? null,
          racesToday: h ? racingToday.has(h.id) : false,
        },
      };
    }
  }

  return <ComposeScreen horses={signedHorses} trainers={trainers} initial={initial} />;
}
