// Shared types for the Compose screen (ENG-176 / T6).
// `type` and `body` mirror the DB columns (post.type, post.body) — NOT
// `media_kind`/`caption`, which don't exist. Only video + photo compose here.

export type MediaType = "video" | "photo";

/** A horse the operator can attribute a post to. Name prefers the racing name. */
export type HorseOption = {
  id: string;
  name: string;
  photoUrl: string | null;
  stableName: string | null;
  /** The horse's stable trainer — the default byline (post.source_trainer_id). */
  trainerId: string | null;
  trainerName: string | null;
  /**
   * True when this horse has a `race` row dated today (AEST). Drives the
   * preview's "Race day" badge, which used to be hardcoded on every post
   * (ENG-558) — the preview claims to show what a subscriber will see, so a
   * badge that is always on is a lie. Loaded in page.tsx.
   */
  racesToday: boolean;
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

// ---------------------------------------------------------------------------
// Media geometry (ENG-558)
//
// Compose used to preview EVERY asset in a hardcoded 16:9 box with a blind
// centre crop, so an operator uploading a 9:16 reel had no way to see it would
// be cropped (Justin, 11 Aug, complaint #3). We measure the picked file in the
// browser and preview it at the SAME clamped ratio the member app uses.
//
// The clamp numbers are deliberately RESTATED here rather than imported from
// mobile: admin and the app are independent codebases, and a "see the other
// repo" reference is exactly how the two copies of this card drifted apart.
// Mobile's matching rule lives in ENG-554. Keep the two in step by hand.
// ---------------------------------------------------------------------------

/** Intrinsic pixel size of the picked file; null until metadata loads. */
export type MediaDimensions = { width: number; height: number } | null;

/**
 * Whether the readout has anything honest to say.
 *
 * `off` matters: in EDIT mode the preview plays a Mux HLS source, and hls.js
 * starts on a low-bitrate rendition, so `videoWidth`/`videoHeight` report the
 * rendition (e.g. 640x360 for a 1080p asset) rather than the asset. Printing
 * that would be worse than printing nothing, so we only ever measure a file
 * the operator just picked off their own disk.
 */
export type MeasureState = "off" | "measuring" | "done";

/** 4:5 — the tallest box a member ever sees. Taller media is cropped to it. */
export const ASPECT_MIN = 0.8;
/** 1.91:1 — the widest box a member ever sees. Wider media is cropped to it. */
export const ASPECT_MAX = 1.91;
/** 16:10 — used while measuring, and whenever the file cannot be measured. */
export const ASPECT_DEFAULT = 1.6;

/**
 * The width/height the preview box should actually use: the file's own ratio,
 * clamped to what the member card will render. Unknown or degenerate input
 * falls back to 16:10 so the box is never 0-height.
 *
 * PHOTOS ALWAYS GET 16:10. A photo has no Mux asset, so it has no
 * `aspect_ratio`, so the member app renders it in the unknown-ratio box by
 * construction. Drawing a photo at its own ratio here would put the preview in
 * direct contradiction with the readout printed above it ("Members see it at
 * 16:10") — the same dishonesty this ticket exists to remove.
 */
export function resolveAspect(dims: MediaDimensions, mediaType: MediaType | null = null): number {
  if (mediaType === "photo") return ASPECT_DEFAULT;
  if (!dims || !(dims.width > 0) || !(dims.height > 0)) return ASPECT_DEFAULT;
  return Math.min(ASPECT_MAX, Math.max(ASPECT_MIN, dims.width / dims.height));
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** "1920x1080" -> "16:9"; odd sizes that don't reduce cleanly -> "1.85:1". */
function ratioLabel(width: number, height: number): string {
  const w = Math.round(width);
  const h = Math.round(height);
  const g = gcd(w, h) || 1;
  const rw = w / g;
  const rh = h / g;
  // A clean broadcast-style ratio (16:9, 4:5, 1:1). Anything that only reduces
  // to big coprime numbers reads as noise, so fall back to a decimal.
  if (rw <= 32 && rh <= 32) return `${rw}:${rh}`;
  const ratio = w / h;
  return ratio >= 1 ? `${Number(ratio.toFixed(2))}:1` : `1:${Number((h / w).toFixed(2))}`;
}

/**
 * The readout printed above the preview: what was detected, and what members
 * will actually get. Never a promise the app won't keep — photos carry no Mux
 * asset, so the member app renders them at 16:10 whatever their real size.
 *
 * (The ticket sketched this as `describeOrientation(dims)`, but the photo rule
 * makes the media type load-bearing, so it takes both.)
 */
export function describeOrientation(dims: MediaDimensions, mediaType: MediaType | null): string {
  if (!dims || !(dims.width > 0) || !(dims.height > 0)) {
    return "Dimensions unavailable · Members see it at 16:10";
  }
  const { width, height } = dims;
  const ratio = width / height;
  const orientation = ratio > 1 ? "Landscape" : ratio < 1 ? "Portrait" : "Square";

  let membersSee: string;
  if (mediaType === "photo") {
    // No Mux asset ⇒ no aspect_ratio ⇒ the app's fixed 16:10 photo box, with
    // object-fit: cover. So a photo that isn't already ~16:10 IS cropped, and
    // saying only "at 16:10" would hide from the operator exactly the harm
    // this ticket exists to surface — a 9:16 photo loses most of its height.
    const off = Math.abs(ratio - ASPECT_DEFAULT) > 0.05;
    membersSee = off ? "Members see it cropped to 16:10" : "Members see it at 16:10";
  } else if (ratio < ASPECT_MIN) {
    membersSee = "Members see it cropped to 4:5";
  } else if (ratio > ASPECT_MAX) {
    membersSee = "Members see it cropped to 1.91:1";
  } else {
    membersSee = `Members see it at ${ratioLabel(width, height)}`;
  }

  return `${width}×${height} · ${orientation} ${ratioLabel(width, height)} · ${membersSee}`;
}

/**
 * Racing names are registered in ALL CAPS ("CANNONBROOK (AUS)"). Members see
 * them title-cased, so the preview must too, or it isn't a preview.
 *
 * Duplicated from mobile's `displayHorseName` (src/components/format.ts) for
 * the same reason as the clamp constants above: separate codebases, no shared
 * package. Rules: a bracketed word is a registrar country code and is left
 * alone; a word that isn't all-caps is deliberately cased and is left alone;
 * capitalisation restarts after an apostrophe or hyphen.
 */
export function displayHorseName(name: string): string {
  return name
    .split(" ")
    .map((word) => {
      if (/^\(.+\)$/.test(word)) return word;
      if (word !== word.toUpperCase() || !/[A-Z]/.test(word)) return word;
      return word
        .toLowerCase()
        .replace(
          /(^|['’-])(\p{L})/gu,
          (_match, boundary: string, letter: string) => boundary + letter.toUpperCase(),
        );
    })
    .join(" ");
}

/**
 * Today's date in Australian Eastern time as `YYYY-MM-DD`, for matching
 * `race.race_date` (a plain DATE column).
 *
 * Uses the real zone, NOT a fixed +10: eastern Australia runs UTC+11 under
 * AEDT (Oct–Apr), so a fixed offset reports yesterday's date for the first
 * hour of every daylight-saving day and the race badge would vanish for horses
 * that are, in fact, racing. Node 22 ships full ICU, so the zone is available.
 */
export const RACING_TIME_ZONE = "Australia/Sydney";

export function aestToday(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, which is exactly the DATE column's shape.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: RACING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
