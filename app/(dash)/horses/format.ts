// Presentation helpers for the Horses DB screens.
//
// Age and the race-day description are NOT computed here (ENG-616). They are
// derived in Postgres — `horse_age()` and `horse_description()`, added by
// ENG-615 and read as PostgREST computed columns — so the 1-August rollover
// rule exists in exactly one place instead of three. This module only COMPOSES
// values it is handed; it never derives them.

export const TRAINING_STATUSES = [
  "spelling",
  "pre_training",
  "farm_training",
  "city_training",
  "racing",
  "retired",
] as const;
export type TrainingStatus = (typeof TRAINING_STATUSES)[number];

// Biological sex, male|female — matching the `horse_sex_check` CHECK. The
// race-day description (colt/filly/mare/horse/gelding) is derived, never
// picked: choosing it by hand is what left a filly a filly at eight.
export const HORSE_SEXES = ["male", "female"] as const;
export type HorseSex = (typeof HORSE_SEXES)[number];

const SEX_LABELS: Record<HorseSex, string> = {
  male: "Male",
  female: "Female",
};

export function horseSexLabel(sex: HorseSex): string {
  return SEX_LABELS[sex];
}

const TRAINING_LABELS: Record<string, string> = {
  spelling: "Spelling",
  pre_training: "Pre-training",
  farm_training: "Farm training",
  city_training: "City training",
  racing: "Racing",
  retired: "Retired",
};

export function humanizeTrainingStatus(value: string | null | undefined): string {
  if (!value) return "";
  return TRAINING_LABELS[value] ?? value;
}

// The status pill class, matching screens/05-horses.html: racing gets the
// green dotted accent; everything else is the neutral pill.
export function statusPillClass(trainingStatus: string | null | undefined): string {
  return trainingStatus === "racing" ? "pill green dot" : "pill";
}

// "by Chris Waller · 5yo gelding" — composed from the values the database
// supplies, never from a local formula.
//
// `retired` keeps its special case: the mockup drops the age for a retired
// horse and shows the training status instead. That comes from
// `training_status`, not from sex, so the database derivation does not cover it
// and it must not be lost.
//
// Degrades honestly when the database has nothing to say: no foaling year means
// `age` is null and, for a non-gelding, `description` is null too, so the line
// falls back to "by <Trainer>" alone rather than inventing an adult default.
export function horseSubtitle(opts: {
  trainerName: string | null | undefined;
  age: number | null | undefined;
  description: string | null | undefined;
  trainingStatus: string | null | undefined;
}): string {
  const by = opts.trainerName ? `by ${opts.trainerName}` : "Unassigned trainer";
  if (opts.trainingStatus === "retired") return `${by} · retired`;
  const bits = [
    opts.age != null ? `${opts.age}yo` : null,
    opts.description ? opts.description.toLowerCase() : null,
  ].filter(Boolean);
  return bits.length ? `${by} · ${bits.join(" ")}` : by;
}

// Compact follower/post counts: 3400 -> "3.4k", 12400 -> "12.4k" (matches the
// mockup, which keeps one decimal place for thousands).
export function formatCount(n: number | null | undefined): string {
  const v = n ?? 0;
  if (v >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(v);
}

// Parse a free-typed dollar amount ("$1.2M", "1,200", "450k") to integer cents.
export function dollarsToCents(input: string | null | undefined): number {
  if (!input) return 0;
  const raw = String(input).trim().toLowerCase().replace(/[$,\s]/g, "");
  const mult = raw.endsWith("m") ? 1_000_000 : raw.endsWith("k") ? 1_000 : 1;
  const num = parseFloat(raw.replace(/[mk]$/, ""));
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * mult * 100);
}
