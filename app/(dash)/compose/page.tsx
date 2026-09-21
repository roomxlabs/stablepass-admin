import { requireAdminPage } from "@/lib/auth/admin";
import ComposeScreen from "./ComposeScreen";
import type { EditInitial, HorseOption, MediaType, Subject, TrainerOption } from "./types";
import { aestToday, isSubject } from "./types";
import {
  loadPostPhotos,
  loadRacingHorseIds,
  one,
  toHorseOptions,
  toTrainerOptions,
  type HorseRow,
  type PostMediaClient,
  type RaceQueryClient,
  type TrainerRow,
} from "./data";
import {
  HORSE_PHOTO_BUCKET,
  POST_MEDIA_BUCKET,
  TRAINER_PHOTO_BUCKET,
  signPhoto,
  signPhotoMap,
} from "@/lib/storage/photos";
import { resolveVideoPlayback } from "@/lib/mux-playback";
import { orderLabels } from "@/lib/posts/labels";
import { orderBylines } from "@/lib/posts/bylines";

/**
 * The types Compose can load for editing — the same four it can create.
 * `news` is excluded on purpose: nothing authors it, so nothing should open it
 * in an editor built around the four authorable types.
 */
const EDITABLE_TYPES: string[] = ["video", "photo", "voice", "text"];

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
  label: string | null;
  /**
   * ENG-1268 (B1) — all three are NULLABLE now. `horse_id` and
   * `source_trainer_id` were `not null`; a trainer post has no horse and a
   * StablePass post has neither, carrying `byline` instead.
   */
  subject: string | null;
  byline: string | null;
  source_trainer_id: string | null;
  scheduled_for: string | null;
  media_url: string | null;
  mux_playback_id: string | null;
  horse: HorseRow | HorseRow[] | null;
  /**
   * ENG-1268 — the post's OWN trainer, embedded for a trainer-subject post so
   * the read-only picked-trainer card and the preview head can render it
   * without hunting through the `trainers` list (which a trainer retired since
   * publication may no longer be in).
   *
   * Guardrail 3: the embed names its columns; `trainer_contact` is not among
   * them and there is no `*` anywhere in this select.
   */
  source_trainer: TrainerRow | TrainerRow[] | null;
};

/** ENG-1268 — a non-retired `post_byline` row for the StablePass picker. */
type BylineRow = { id: string; name: string; sort_order: number };

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
  const [horsesRes, trainersRes, racing, labelsRes, bylinesRes] = await Promise.all([
    sb
      .from("horse")
      .select(
        "id,display_name,racing_name,photo_url,stable_name,trainer_id,trainer:trainer_id(id,name,display_name)",
      )
      .eq("status", "active")
      .order("display_name"),
    // GUARDRAIL 3 — the columns are named, one by one, and `trainer_contact`
    // is not among them. ENG-1268 widened this past `id,name,display_name`
    // because the Trainer subject's search row and preview head render the
    // photo and the `stable · location` subline; it must never widen further.
    sb
      .from("trainer")
      .select("id,name,display_name,stable_name,location,photo_url")
      .order("name"),
    // Cast through unknown, same reason as lib/dashboard/queries.ts: with no
    // generated DB types, matching supabase-js's builder generics against a
    // hand-written structural type makes tsc unroll them (TS2589).
    loadRacingHorseIds(sb as unknown as RaceQueryClient, aestToday()),
    // ENG-979 — the live editorial categories. Read here, server-side, so the
    // picker is populated in the FIRST paint: a client fetch on mount would
    // leave the field empty for a beat, and an operator who opens Compose and
    // sees no categories has no reason to wait for a second one to arrive.
    // ENG-1268 — `id` is new here (the picker's retire action needs it), and
    // so is `.is("retired_at", null)`: ENG-1267 added that exclusion to
    // `GET /api/admin/post-labels`, but this page reads `post_label` directly
    // and so never got it, leaving retired labels on offer in the first paint.
    // Mirroring it is the other half of that ticket, called out in
    // `.rx/gotchas.md` as A3's to close. A label the EDITED post still carries
    // is unioned back in client-side — see ComposeScreen's `options`.
    sb.from("post_label").select("id,name,is_builtin,sort_order").is("retired_at", null),
    // ENG-1268 — the StablePass byline vocabulary, read here for the same
    // first-paint reason the labels are.
    //
    // `.is("retired_at", null)` MIRRORS the filter A2 put on
    // `GET /api/admin/post-bylines`. This page reads `post_byline` DIRECTLY
    // rather than through that route, so without this line the picker's
    // server-rendered first paint would offer retired bylines the route has
    // already withdrawn — the half-shipped-filter trap recorded in
    // `.rx/gotchas.md`. Any future change to one reader must be made to both.
    sb.from("post_byline").select("id,name,sort_order").is("retired_at", null),
  ]);

  const racingToday = racing.ids;

  const horses: HorseOption[] = toHorseOptions(horsesRes.data as HorseRow[] | null, racingToday);
  const trainers: TrainerOption[] = toTrainerOptions(trainersRes.data as TrainerRow[] | null);

  // Private buckets: sign each pickable horse's / trainer's photo path for
  // display. One round-trip per bucket for the whole set, never one per row.
  const [horsePhotos, trainerPhotos] = await Promise.all([
    signPhotoMap(sb, HORSE_PHOTO_BUCKET, horses.map((h) => h.photoUrl)),
    signPhotoMap(sb, TRAINER_PHOTO_BUCKET, trainers.map((t) => t.photoUrl)),
  ]);
  const signedHorses: HorseOption[] = horses.map((h) => ({
    ...h,
    photoUrl: h.photoUrl ? horsePhotos.get(h.photoUrl) ?? null : null,
  }));
  // ENG-1268 — the Trainer subject's search rows and preview head. A trainer
  // with no photo (or one that fails to sign) keeps `null` and falls through
  // to the initials avatar, exactly as a horse does.
  const signedTrainers: TrainerOption[] = trainers.map((t) => ({
    ...t,
    photoUrl: t.photoUrl ? trainerPhotos.get(t.photoUrl) ?? null : null,
  }));

  // Edit mode: load the post identified by ?id and hydrate the form. Only
  // video/photo posts are editable here (compose only handles those types).
  let initial: EditInitial | undefined;
  if (id) {
    const { data } = await sb
      .from("post")
      .select(
        // ENG-1268 adds `subject`, `byline` and the `source_trainer` embed.
        // Guardrail 3: every column is named; `trainer_contact` appears
        // nowhere and there is no `*`.
        // ONE STRING LITERAL, never a concatenation: `"a" + "b"` widens to
        // plain `string`, which collapses supabase-js's `.select()` overload to
        // `GenericStringError[]` and fails `tsc` on every field access below,
        // naming neither the concatenation nor the column (`.rx/gotchas.md`).
        "id,type,status,title,body,label,subject,byline,source_trainer_id,scheduled_for,media_url,mux_playback_id,horse:horse_id(id,display_name,racing_name,photo_url,stable_name,trainer_id,trainer:trainer_id(id,name,display_name)),source_trainer:source_trainer_id(id,name,display_name,stable_name,location,photo_url)",
      )
      .eq("id", id)
      .maybeSingle();
    const post = data as PostRow | null;
    // ENG-611: `voice` and `text` are editable too. Leaving them out here was
    // not "edit is unsupported" — the posts library links EVERY row to
    // `/compose?id=…`, so an unmatched type fell through to `initial =
    // undefined` and opened a blank CREATE form, which would mint a SECOND
    // post and silently strand the original.
    if (post && EDITABLE_TYPES.includes(post.type)) {
      const h = one(post.horse);
      const t = h ? one(h.trainer) : null;
      // photo AND voice → signed Storage URL (same private bucket, same
      // object); video → signed Mux HLS URL (reconciled from Mux on read if
      // the webhook hasn't set mux_playback_id yet); text → no media at all.
      // ENG-1268 — the post's own trainer, for a trainer-subject post.
      const st = one(post.source_trainer);
      const [horsePhoto, trainerPhoto, mediaUrl] = await Promise.all([
        signPhoto(sb, HORSE_PHOTO_BUCKET, h?.photo_url ?? null),
        signPhoto(sb, TRAINER_PHOTO_BUCKET, st?.photo_url ?? null),
        post.type === "photo" || post.type === "voice"
          ? signPhoto(sb, POST_MEDIA_BUCKET, post.media_url)
          : post.type === "video"
            ? resolveVideoPlayback(sb, { id: post.id, mux_playback_id: post.mux_playback_id }).then(
                (p) => p.playbackUrl,
              )
            : Promise.resolve(null),
      ]);
      // ENG-1266 — the post's CURRENT ordered photo set, for edit mode's photo
      // strip. Lives in `loadPostPhotos` (data.ts), NOT inline, for the same
      // reason `loadRacingHorseIds` does above: this file is an async server
      // component and cannot be unit-tested, and this read has its own
      // "errored read is not empty" branch that a regression could silently
      // delete here without a single test noticing. Photo posts only; every
      // other type keeps `{ photos: [], photosUnavailable: false }`.
      let photos: { path: string; url: string | null }[] = [];
      let photosUnavailable = false;
      if (post.type === "photo") {
        const result = await loadPostPhotos(
          // Cast through unknown, same reason as `loadRacingHorseIds` above:
          // with no generated DB types, matching supabase-js's builder
          // generics against a hand-written structural type makes tsc unroll
          // them (TS2589).
          sb as unknown as PostMediaClient,
          post.id,
          post.media_url,
          (paths) => signPhotoMap(sb, POST_MEDIA_BUCKET, paths),
        );
        photos = result.photos;
        photosUnavailable = result.photosUnavailable;
      }

      // ENG-1268 — `post.subject` is `horse` for every row B1's migration
      // backfilled, so an unrecognised value can only be a build older than
      // the database. Falling back to `horse` keeps such a post editable
      // rather than opening a screen with no subject at all.
      const subject: Subject = isSubject(post.subject) ? post.subject : "horse";

      initial = {
        id: post.id,
        status: post.status,
        subject,
        mediaType: post.type as MediaType,
        mediaUrl,
        title: post.title ?? "",
        caption: post.body ?? "",
        label: post.label ?? null,
        // The byline NAME, straight off the row — including one whose
        // `post_byline` row has since been RETIRED and is therefore absent
        // from the picker's options above. ComposeScreen unions it back in;
        // dropping it here would blank the post's own attribution on save.
        byline: post.byline ?? null,
        bylineId: post.source_trainer_id ?? "",
        scheduledFor: post.scheduled_for,
        // NULL for a trainer / StablePass post — `post.horse_id` is nullable
        // as of B1, and inventing an "Unnamed horse" placeholder here is what
        // would put a horse head on a post that has no horse.
        horse: h
          ? {
              id: h.id,
              name: h.racing_name ?? h.display_name ?? "Unnamed horse",
              photoUrl: horsePhoto,
              stableName: h.stable_name ?? null,
              trainerId: h.trainer_id ?? t?.id ?? null,
              trainerName: t?.name ?? t?.display_name ?? null,
              racesToday: racingToday.has(h.id),
            }
          : null,
        trainer: st
          ? {
              id: st.id,
              name: st.name ?? st.display_name ?? "Unnamed trainer",
              photoUrl: trainerPhoto,
              stableName: st.stable_name ?? null,
              location: st.location ?? null,
            }
          : null,
        photos,
        photosUnavailable,
      };
    }
  }

  // Builtins first in be's seeded order, then admin-added ones alphabetically.
  // Literally the SAME function `GET /api/admin/post-labels` calls, not a
  // matching copy — so the picker cannot reshuffle between a server render and
  // the route's view of the list.
  //
  // A failed/empty read falls through to `undefined`, and ComposeScreen's
  // default (the 14 immutable builtins) takes over. Those rows cannot be
  // deleted, so "no rows came back" always means the READ failed, never that
  // the vocabulary is genuinely empty — and offering the guaranteed floor beats
  // offering nothing.
  const labelRows = (labelsRes.data ?? []) as {
    id: string;
    name: string;
    is_builtin: boolean;
    sort_order: number;
  }[];
  const ordered = labelRows.length ? orderLabels(labelRows) : [];
  const labels = ordered.length ? ordered.map((r) => r.name) : undefined;
  /**
   * ENG-1268 — the same rows, carrying what the RETIRE (×) action needs: the
   * id to call, and `is_builtin` so a builtin is never offered the action.
   *
   * A parallel prop rather than a reshaped `labels`, deliberately: `labels`
   * is the picker's value list and has a guaranteed non-empty floor
   * (ComposeScreen's 14 builtins) that this list must NOT have — offering a
   * retire button for a row we never actually read would call the route with
   * an id we invented. So an empty read means "no retire actions", which is
   * the safe failure, while the picker still lists the builtins.
   */
  const labelActions = ordered.map((r) => ({ id: r.id, name: r.name, isBuiltin: r.is_builtin }));

  // ENG-1268 — the StablePass byline vocabulary, already filtered to
  // non-retired rows by the query above and ordered the same way the route
  // orders it (`sort_order`, then name) so the picker cannot reshuffle between
  // this server render and a later client read.
  const bylines = orderBylines((bylinesRes.data ?? []) as BylineRow[]).map((r) => ({
    id: r.id,
    name: r.name,
  }));

  return (
    <ComposeScreen
      horses={signedHorses}
      trainers={signedTrainers}
      initial={initial}
      labels={labels}
      labelActions={labelActions}
      bylines={bylines}
    />
  );
}
