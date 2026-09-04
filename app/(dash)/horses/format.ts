// Presentation helpers for the Horses DB screens.
//
// Age and the race-day description are NOT computed here (ENG-616). They are
// derived in Postgres — `horse_age()` and `horse_description()`, added by
// ENG-615 and read as PostgREST computed columns — so the 1-August rollover
// rule exists in exactly one place instead of three. This module only COMPOSES
// values it is handed; it never derives them.

// The 1 Sep 2026 lifecycle (Justin, iMessage 1363/1369): Breaking In is a new
// first education stage, and the farm/city split merged into one In Training
// (be migration 20260901120000 merged the rows for real). Picker order follows
// the horse's actual lifecycle.
export const TRAINING_STATUSES = [
  "spelling",
  "breaking_in",
  "pre_training",
  "in_training",
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
  breaking_in: "Breaking in",
  pre_training: "Pre-training",
  in_training: "In training",
  // Legacy spellings — merged into in_training by be migration 20260901120000;
  // kept so a stale row read before that deploy still labels correctly.
  farm_training: "In training",
  city_training: "In training",
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
