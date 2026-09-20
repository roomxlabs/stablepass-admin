// Pure row -> option mapping for the Compose loader.
//
// This lives outside page.tsx on purpose (same split as app/(dash)/trainers/
// data.ts): page.tsx is an async server component that needs a real Supabase
// client, so anything left inside it is effectively untestable. The race-day
// badge in particular MUST be provably data-driven — it was hardcoded on every
// post before ENG-558, and a hardcoded value inside the loader would otherwise
// sail through the whole suite.
import type { HorseOption, TrainerOption } from "./types";

export type HorseRow = {
  id: string;
  display_name: string | null;
  racing_name: string | null;
  photo_url: string | null;
  stable_name: string | null;
  trainer_id: string | null;
  trainer:
    | { id: string; name: string | null; display_name: string | null }
    | Array<{ id: string; name: string | null; display_name: string | null }>
    | null;
};

export type TrainerRow = { id: string; name: string | null; display_name: string | null };

/** Today's races, embedded down to their runners' horse ids. */
export type RaceTodayRow = { race_horse: Array<{ horse_id: string }> | null };

/** PostgREST returns a to-one embed as an object OR a 1-element array. */
export function one<T>(v: T | T[] | null): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/**
 * The set of horse ids with a runner in one of today's races.
 *
 * `rows` is null when the query ERRORED, which is not the same fact as "no
 * horse races today" — the caller must distinguish the two, because silently
 * treating a failed read as an empty result is how a badge turns into
 * permanent background flakiness (CLAUDE.md: empty is not "no data").
 */
export function racingHorseIds(rows: RaceTodayRow[] | null): Set<string> {
  return new Set((rows ?? []).flatMap((r) => (r.race_horse ?? []).map((rh) => rh.horse_id)));
}

/** The narrow slice of the Supabase client this loader needs, so it can be
 *  unit-tested with a spy that actually records its filter arguments. */
export type RaceQueryClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: string,
      ) => PromiseLike<{ data: RaceTodayRow[] | null; error: { message: string } | null }>;
    };
  };
};

/**
 * Which horses run today, for the preview's "Race day" badge.
 *
 * This lives here rather than inline in `page.tsx` because `page.tsx` is an
 * async server component and is therefore effectively untestable — and the
 * whole point of ENG-558 is that a badge which is always on is a lie. Inline,
 * three separate regressions passed the full suite: dropping the `race_date`
 * filter (every horse that ever raced gets a badge), deleting the error branch,
 * and building the set from horse ids instead of race rows. Two of those three
 * are pinned by this function's tests.
 *
 * `failed` is reported rather than inferred: an empty set from an ERROR is not
 * the same fact as an empty set from "nobody races today" (CLAUDE.md — an AAL1
 * admin reads 0 rows with no error). Either way the screen still renders: the
 * badge is advisory and must never block composing.
 */
export async function loadRacingHorseIds(
  sb: RaceQueryClient,
  today: string,
): Promise<{ ids: Set<string>; failed: boolean }> {
  const res = await sb.from("race").select("race_horse(horse_id)").eq("race_date", today);
  if (res.error) {
    // Log the message only — never the error object, its details or its hint.
    console.error("compose: race-day lookup failed, badges suppressed", res.error.message);
    return { ids: new Set<string>(), failed: true };
  }
  return { ids: racingHorseIds(res.data), failed: false };
}

export function toHorseOptions(rows: HorseRow[] | null, racingToday: Set<string>): HorseOption[] {
  return (rows ?? []).map((h) => {
    const t = one(h.trainer);
    return {
      id: h.id,
      name: h.racing_name ?? h.display_name ?? "Unnamed horse",
      photoUrl: h.photo_url,
      stableName: h.stable_name,
      trainerId: h.trainer_id ?? t?.id ?? null,
      trainerName: t?.name ?? t?.display_name ?? null,
      racesToday: racingToday.has(h.id),
    };
  });
}

export function toTrainerOptions(rows: TrainerRow[] | null): TrainerOption[] {
  return (rows ?? []).map((t) => ({
    id: t.id,
    name: t.name ?? t.display_name ?? "Unnamed trainer",
  }));
}

// ---------------------------------------------------------------------------
// loadPostPhotos — the post_media read for edit mode's photo strip.
// ---------------------------------------------------------------------------

export type PostMediaRow = { media_url: string | null; sort_order: number };
export type PostPhoto = { path: string; url: string | null };

/** The narrow slice of the Supabase client this loader needs, so it can be
 *  unit-tested with a spy — same idiom as `RaceQueryClient` above. */
export type PostMediaClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: string,
      ) => {
        order: (
          column: string,
        ) => PromiseLike<{ data: PostMediaRow[] | null; error: { message: string } | null }>;
      };
    };
  };
};

/**
 * ENG-1266 — the post's CURRENT ordered photo set, so edit mode can show
 * the strip and add/remove/reorder against it instead of a read-only
 * frame. Photo posts only; every other type keeps an empty list.
 *
 * A post written before ENG-748 has NO `post_media` rows — the single
 * object lives only in `post.media_url`. That is not "no photos", it is
 * one photo, so the legacy row is synthesised into a one-entry set.
 *
 * "THE READ FAILED" IS NOT "THE POST HAS NO ROWS", and conflating the two
 * destroys data. Since this ticket an edit save sends the strip as the
 * WHOLE `media` set, and `PATCH /posts/:id` implements that by deleting
 * every `post_media` row above the ones it was given. So a transient
 * PostgREST/network failure on this read would render a 5-photo post as a
 * 1-photo strip, and the operator's next save — even a pure caption fix —
 * would hard-delete rows 1..4 under a cheerful "Changes saved."
 *
 * So an errored read degrades to exactly the pre-ENG-1266 screen: media
 * read-only, and `media` absent from every save. Caption/byline/label
 * edits still work; the photos are simply not up for editing in a session
 * that could not see them. Only `error === null` is allowed to mean
 * "this post genuinely has no rows".
 *
 * `signSet` is INJECTED rather than called directly against a Storage
 * client, so this function is unit-testable with a plain spy instead of a
 * real (or faked) Supabase Storage client — the same reason the sb chain
 * itself is a narrow structural type instead of `SupabaseClient`.
 */
export async function loadPostPhotos(
  sb: PostMediaClient,
  postId: string,
  mediaUrlMirror: string | null,
  signSet: (paths: string[]) => Promise<Map<string, string>>,
): Promise<{ photos: PostPhoto[]; photosUnavailable: boolean }> {
  const { data: mediaRows, error: mediaError } = await sb
    .from("post_media")
    .select("media_url,sort_order")
    .eq("post_id", postId)
    .order("sort_order");
  if (mediaError) {
    // Includes the deploy-order case (`post_media` not migrated yet):
    // sending `media` then would 400 the whole save anyway.
    return { photos: [], photosUnavailable: true };
  }
  const rows = (mediaRows ?? []) as PostMediaRow[];
  // `post_media.media_url` is `not null` (stablepass-be
  // supabase/migrations/20260819120002_post_media.sql:91), so this filter is
  // belt-and-braces against this hand-written row type, not a real third
  // "cannot represent the set" case.
  const paths = rows.map((r) => r.media_url).filter((v): v is string => !!v);
  // The legacy fallback, and also the belt-and-braces for a post whose
  // rows exist but whose mirror is not among them.
  const ordered = paths.length > 0 ? paths : mediaUrlMirror ? [mediaUrlMirror] : [];
  // A path this post could never save back.
  //
  // `PATCH /posts/:id` runs every incoming path through
  // `normaliseMediaSet(value, postId)`, which requires the `<postId>/`
  // prefix. Before this ticket edit mode never sent `media`, so a photo
  // post whose `media_url` predates that convention (an old import, a
  // stored absolute URL) was simply uneditable-media but perfectly
  // saveable. Now that every photo save carries the set, such a post
  // would 400 on a plain CAPTION edit and could never be saved again.
  //
  // So it degrades exactly as an errored read does: photos read-only,
  // `media` omitted, everything else still editable. Checked here rather
  // than trusted to be impossible, because it is a property of rows
  // written by older code, not of anything this build controls.
  if (ordered.some((path) => !path.startsWith(`${postId}/`))) {
    return { photos: [], photosUnavailable: true };
  }
  // One round-trip for the whole set rather than N sequential signs.
  const signedSet = await signSet(ordered);
  const photos = ordered.map((path) => ({ path, url: signedSet.get(path) ?? null }));
  return { photos, photosUnavailable: false };
}
