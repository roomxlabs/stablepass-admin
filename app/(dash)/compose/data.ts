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
