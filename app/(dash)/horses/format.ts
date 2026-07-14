// Presentation helpers for the Horses DB screens.
// Age is COMPUTED here and never stored (guardrail): a horse turns a year
// older on 1 August, so before August it is one year younger than the raw
// calendar-year difference.

export const TRAINING_STATUSES = [
  "spelling",
  "pre_training",
  "farm_training",
  "city_training",
  "racing",
  "retired",
] as const;
export type TrainingStatus = (typeof TRAINING_STATUSES)[number];

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

// Age in years from foaling_year (turns over on 1 August). Returns null when
// there is no foaling year on record.
export function computeAge(foalingYear: number | null | undefined, now: Date = new Date()): number | null {
  if (!foalingYear) return null;
  const augustPassed = now.getMonth() >= 7; // 0-indexed: 7 = August
  const age = now.getFullYear() - foalingYear - (augustPassed ? 0 : 1);
  return age >= 0 ? age : null;
}

// "by Chris Waller · 5yo gelding" — or "· retired" for a retired horse (matches
// the mockup, which drops age for retired horses).
export function horseMeta(opts: {
  trainerName: string | null | undefined;
  foalingYear: number | null | undefined;
  sex: string | null | undefined;
  trainingStatus: string | null | undefined;
}): string {
  const by = opts.trainerName ? `by ${opts.trainerName}` : "Unassigned trainer";
  if (opts.trainingStatus === "retired") return `${by} · retired`;
  const age = computeAge(opts.foalingYear);
  const bits = [age != null ? `${age}yo` : null, opts.sex ? opts.sex.toLowerCase() : null].filter(Boolean);
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
