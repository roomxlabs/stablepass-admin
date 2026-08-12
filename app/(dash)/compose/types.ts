// Shared types for the Compose screen (ENG-176 / T6).
// `type` and `body` mirror the DB columns (post.type, post.body) — NOT
// `media_kind`/`caption`, which don't exist. Only video + photo compose here.

export type MediaType = "video" | "photo";

/* ---- Media geometry (ENG-558) --------------------------------------------
 * The intrinsic size of the asset the operator picked, measured in the browser
 * before any upload, plus the rule that turns it into the box a member will
 * actually see.
 *
 * The clamp numbers are DELIBERATELY DUPLICATED from the member app rather than
 * imported: admin and mobile are separate codebases, and a "see the other repo"
 * reference is exactly how the two silently drift. Any change here must be made
 * in the app's post card too.
 */

/** Measured intrinsic size of the chosen asset; null until metadata lands. */
export type MediaDimensions = { width: number; height: number } | null;

export const ASPECT_MIN = 0.8; // 4:5 — the most portrait a member ever sees
export const ASPECT_MAX = 1.91; // 1.91:1 — the widest a member ever sees
export const ASPECT_DEFAULT = 1.6; // 16:10 — unknown aspect

/** The one place that decides whether a measurement is usable. */
export function hasUsableDimensions(dims: MediaDimensions): dims is { width: number; height: number } {
  return !!dims && dims.width > 0 && dims.height > 0;
}

/**
 * The asset's real ratio, clamped to the range a member can be shown. Total —
 * unmeasured, zero, negative and NaN all fall back to 16:10, so the preview box
 * is never 0-height.
 */
export function resolveAspect(dims: MediaDimensions): number {
  if (!hasUsableDimensions(dims)) return ASPECT_DEFAULT;
  return Math.min(ASPECT_MAX, Math.max(ASPECT_MIN, dims.width / dims.height));
}

/**
 * The box to actually draw, which is not always the clamped measurement:
 * photos are Supabase Storage assets with no Mux `aspect_ratio`, so the app
 * renders every one of them at 16:10 whatever we measured. Previewing a 4:5
 * photo box would promise framing the app will not deliver.
 */
export function resolveMemberAspect(dims: MediaDimensions, mediaType: MediaType | null): number {
  return mediaType === "photo" ? ASPECT_DEFAULT : resolveAspect(dims);
}

/**
 * Ratios an operator recognises by name, matched within RATIO_TOLERANCE.
 * Anything else falls back to a decimal form (`1:2.17`).
 */
const NAMED_RATIOS: ReadonlyArray<readonly [number, string]> = [
  [16 / 9, "16:9"],
  [9 / 16, "9:16"],
  [4 / 5, "4:5"],
  [5 / 4, "5:4"],
  [1, "1:1"],
  [4 / 3, "4:3"],
  [3 / 4, "3:4"],
  [3 / 2, "3:2"],
  [2 / 3, "2:3"],
  [16 / 10, "16:10"],
  [10 / 16, "10:16"],
  [1.91, "1.91:1"],
  [2.35, "2.35:1"],
];
// 0.5% — tight enough to keep 2.35:1 and 21:9 (2.333) from colliding, loose
// enough that a 1918x1080 encode still reads as 16:9.
const RATIO_TOLERANCE = 0.005;

/** "16:9" / "4:5" / "1:2.17" — a ratio an operator can read at a glance. */
export function describeRatio(value: number): string {
  for (const [ratio, label] of NAMED_RATIOS) {
    if (Math.abs(value - ratio) / ratio <= RATIO_TOLERANCE) return label;
  }
  return value >= 1 ? `${value.toFixed(2)}:1` : `1:${(1 / value).toFixed(2)}`;
}

/**
 * The readout line: what was detected, and what members actually get.
 *
 *   1920×1080 · Landscape 16:9 · Members see it at 16:9
 *   1080×1920 · Portrait 9:16 · Members see it cropped to 4:5
 *   Dimensions unavailable · Members see it at 16:10
 *
 * `mediaType` is load-bearing, not decorative — see `resolveMemberAspect`.
 *
 * Both the orientation word and the "cropped" verb are derived from the RATIO
 * LABELS, not from the raw floats: naming a 1080×1352 asset "4:5" and then
 * saying it is "cropped to 4:5" — or calling 1080×1081 "Portrait 1:1" — is the
 * line contradicting itself over a rounding margin the operator cannot see.
 */
export function describeOrientation(dims: MediaDimensions, mediaType: MediaType | null): string {
  if (!hasUsableDimensions(dims)) {
    return `Dimensions unavailable · Members see it at ${describeRatio(ASPECT_DEFAULT)}`;
  }

  const raw = dims.width / dims.height;
  const rawLabel = describeRatio(raw);
  const size = `${dims.width}×${dims.height}`;
  const orientation = rawLabel === "1:1" ? "Square" : raw > 1 ? "Landscape" : "Portrait";
  const detected = `${size} · ${orientation} ${rawLabel}`;

  if (mediaType === "photo") {
    // Locked copy: photos read "at 16:10", never "cropped to". Every photo
    // lands on the same default regardless of what it is, so there is no
    // per-asset promise to qualify.
    return `${detected} · Members see it at ${describeRatio(ASPECT_DEFAULT)}`;
  }

  const memberLabel = describeRatio(resolveAspect(dims));
  const verb = memberLabel === rawLabel ? "at" : "cropped to";
  return `${detected} · Members see it ${verb} ${memberLabel}`;
}

/** A horse the operator can attribute a post to. Name prefers the racing name. */
export type HorseOption = {
  id: string;
  name: string;
  photoUrl: string | null;
  stableName: string | null;
  /** The horse's stable trainer — the default byline (post.source_trainer_id). */
  trainerId: string | null;
  trainerName: string | null;
};

/** A trainer for the editable byline dropdown (the full list is loaded). */
export type TrainerOption = {
  id: string;
  name: string;
};

/**
 * The 202 payload from `POST /api/admin/posts`. Video drafts carry a Mux
 * one-time `uploadUrl` (+ `muxUploadId`); photo drafts carry a Supabase
 * Storage signed-upload target (`uploadUrl` + `path` + `token` + `bucket`).
 * The browser PUTs the file bytes straight to that target — never through us.
 */
export type CreateDraftResponse = {
  id: string;
  status: string;
  type: MediaType;
  watermarked: boolean;
  uploadUrl: string;
  // video
  muxUploadId?: string;
  // photo
  path?: string;
  token?: string;
  bucket?: string;
};

/**
 * An existing post loaded into Compose for editing. The PATCH contract only
 * covers `body` (caption) + `source_trainer_id` (byline), so horse and media
 * are shown read-only. `mediaUrl` is a signed photo URL for photos, or a
 * signed Mux HLS URL for videos (null → asset still processing → placeholder).
 * `scheduledFor` is the post's current schedule as a UTC ISO instant (null when
 * the post has never been scheduled) — the edit-mode Schedule section prefills
 * its Date+Time pair from it, converted to the browser's timezone.
 */
export type EditInitial = {
  id: string;
  status: string; // draft | scheduled | published | unpublished
  mediaType: MediaType;
  mediaUrl: string | null;
  title: string;
  caption: string;
  bylineId: string;
  scheduledFor: string | null;
  horse: HorseOption;
};
