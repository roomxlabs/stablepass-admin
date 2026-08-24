// Shared types for the Compose screen (ENG-176 / T6).
// `type` and `body` mirror the DB columns (post.type, post.body) — NOT
// `media_kind`/`caption`, which don't exist.
//
// ENG-611 widened this to all four authorable types. `post.type`'s CHECK has
// permitted ('video','photo','text','voice','news') since the baseline schema,
// so nothing here needed a migration. `news` is deliberately NOT included:
// it exists in the schema but nothing authors it and it was never asked for.

export type MediaType = "video" | "photo" | "voice" | "text";

/**
 * The three that carry an uploaded asset. `text` has none — its title and body
 * are the whole post, which is exactly why it could not be authored before:
 * the type used to be sniffed from the picked file's MIME, and a text post has
 * no file to sniff.
 */
export const UPLOAD_TYPES = ["video", "photo", "voice"] as const;
export type UploadType = (typeof UPLOAD_TYPES)[number];

/**
 * Membership, NOT `!== "text"`. `post.type`'s CHECK still permits `news`, and
 * `page.tsx` casts a loaded row's type straight to `MediaType`, so a negative
 * test would wave `news` through as an "upload type" and then index
 * ACCEPT_BY_TYPE / TYPE_LABEL with it and get `undefined`.
 */
export function isUploadType(type: MediaType): type is UploadType {
  return (UPLOAD_TYPES as readonly string[]).includes(type);
}

/** `accept` for the file input, narrowed to the type the operator chose. */
export const ACCEPT_BY_TYPE: Record<UploadType, string> = {
  video: "video/*",
  photo: "image/*",
  voice: "audio/*",
};

/** Picker labels, also used verbatim in the MIME-mismatch error copy. */
export const TYPE_LABEL: Record<MediaType, string> = {
  video: "Video",
  photo: "Photo",
  voice: "Voice",
  text: "Text",
};

/**
 * The upload type a picked file's MIME implies, or null when it is none of the
 * three. This is now **validation only** — never reclassification. Choosing
 * Video and then picking a `.jpg` is an error the operator has to resolve; the
 * screen must not quietly turn their video post into a photo post.
 *
 * Deliberately the MIME PREFIX only: a codec the browser cannot decode is
 * still a perfectly uploadable file, so decodability must never gate the pick.
 */
export function uploadTypeForFile(file: File): UploadType | null {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("image/")) return "photo";
  if (file.type.startsWith("audio/")) return "voice";
  return null;
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
 * one-time `uploadUrl` (+ `muxUploadId`); photo AND voice drafts carry a
 * Supabase Storage signed-upload target (`uploadUrl` + `path` + `token` +
 * `bucket`). The browser PUTs the file bytes straight to that target — never
 * through us.
 *
 * `uploadUrl` is OPTIONAL because a `text` draft has no upload target at all:
 * the route returns 202 with just the draft, and makes no Storage or Mux call
 * to fail. Anything reading `uploadUrl` must therefore narrow on the type
 * first, which is what `isUploadType` is for.
 */
export type CreateDraftResponse = {
  id: string;
  status: string;
  type: MediaType;
  watermarked: boolean;
  /** Absent for `text`. */
  uploadUrl?: string;
  // video
  muxUploadId?: string;
  // photo | voice
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

/**
 * 4:5 — the tallest box a NON-REEL asset draws. Taller media is cropped to it.
 *
 * No longer "the tallest box a member ever sees": since the 18 Aug 2026 reel
 * work a portrait VIDEO is exempt from this floor. See REEL_ASPECT_MIN.
 */
export const ASPECT_MIN = 0.8;
/**
 * 9:16 — the tallest box a REEL draws (client, 18 Aug 2026: a portrait video
 * follows Instagram's reel treatment, full uncropped ratio, while everything
 * else keeps the classic card). Only a portrait VIDEO takes this floor:
 * portrait PHOTOS keep the 4:5 clamp on the member card, and on this screen
 * they keep the 16:10 photo box for the reason given in resolveAspect.
 *
 * Duplicated from mobile's REEL_ASPECT_MIN (src/components/post-card.tsx) for
 * the same reason as the other clamp constants here: separate codebases, no
 * shared package. The member card is the contract; keep the two in step.
 */
export const REEL_ASPECT_MIN = 9 / 16;
/** 1.91:1 — the widest box a member ever sees. Wider media is cropped to it. */
export const ASPECT_MAX = 1.91;
/** 16:10 — used while measuring, and whenever the file cannot be measured. */
export const ASPECT_DEFAULT = 1.6;

/**
 * The width/height the preview box should actually use: the file's own ratio,
 * clamped to what the member card will render. Unknown or degenerate input
 * falls back to 16:10 so the box is never 0-height.
 *
 * A PORTRAIT VIDEO IS A REEL and is the one asset exempt from the 4:5 floor —
 * it draws at its own ratio down to 9:16, exactly as the member card has done
 * since 18 Aug 2026. See REEL_ASPECT_MIN and the reel branch below.
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
  const ratio = dims.width / dims.height;
  // THE REEL BRANCH, mirroring the member card: a portrait VIDEO draws at its
  // own ratio down to 9:16 instead of being floored at 4:5. The RAW ratio
  // decides, before any clamp — clamping first would floor a 9:16 at 0.8 and
  // hide the very thing that makes it a reel.
  //
  // `mediaType === "video"` is deliberate rather than "not a photo": `null`
  // here means a TEXT post (ComposeScreen reports text as null, see its
  // previewData comment), and a voice post has no frame to measure. Both are
  // gated out of the media box upstream anyway, but the box must not depend
  // on that.
  if (mediaType === "video" && ratio < 1) return Math.max(REEL_ASPECT_MIN, ratio);
  return Math.min(ASPECT_MAX, Math.max(ASPECT_MIN, ratio));
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * "1920x1080" -> "16:9"; odd sizes that don't reduce cleanly -> "1.85:1".
 *
 * Returns the two numbers ACTUALLY PRINTED alongside the label, because the
 * orientation word must be derived from those and not from the raw float. At
 * 1080x1081 the float is portrait while the printed label rounds to 1:1, and
 * "Portrait 1:1" is a self-contradiction sitting in the operator's readout.
 */
function ratioParts(width: number, height: number): { label: string; w: number; h: number } {
  const w = Math.round(width);
  const h = Math.round(height);
  const g = gcd(w, h) || 1;
  const rw = w / g;
  const rh = h / g;
  // A clean broadcast-style ratio (16:9, 4:5, 1:1). Anything that only reduces
  // to big coprime numbers reads as noise, so fall back to a decimal.
  if (rw <= 32 && rh <= 32) return { label: `${rw}:${rh}`, w: rw, h: rh };
  const ratio = w / h;
  if (ratio >= 1) {
    const n = Number(ratio.toFixed(2));
    return n === 1 ? { label: "1:1", w: 1, h: 1 } : { label: `${n}:1`, w: n, h: 1 };
  }
  const n = Number((h / w).toFixed(2));
  return n === 1 ? { label: "1:1", w: 1, h: 1 } : { label: `1:${n}`, w: 1, h: n };
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
  // Orientation comes from the PRINTED ratio, never the raw float — see
  // ratioParts. A line that reads "Portrait 1:1" tells the operator nothing.
  const { label, w: rw, h: rh } = ratioParts(width, height);
  const orientation = rw > rh ? "Landscape" : rw < rh ? "Portrait" : "Square";

  let membersSee: string;
  if (mediaType === "photo") {
    // No Mux asset ⇒ no aspect_ratio ⇒ the app's fixed 16:10 photo box, with
    // object-fit: cover. So a photo that isn't already ~16:10 IS cropped, and
    // saying only "at 16:10" would hide from the operator exactly the harm
    // this ticket exists to surface — a 9:16 photo loses most of its height.
    const off = Math.abs(ratio - ASPECT_DEFAULT) > 0.05;
    membersSee = off ? "Members see it cropped to 16:10" : "Members see it at 16:10";
  } else if (mediaType === "video" && ratio < ASPECT_MIN) {
    // THE REEL BRANCH. Below 4:5 a portrait video is no longer cropped into a
    // 4:5 box: it plays as a reel at its own ratio, floored at 9:16, so only
    // something TALLER than 9:16 actually loses anything. Between 4:5 and
    // square the reel and classic paths draw an identical box, so that copy is
    // left alone rather than saying "reel" where it changes nothing the
    // operator can see — and where the printed label can round to 1:1.
    membersSee =
      ratio < REEL_ASPECT_MIN
        ? "Members see it as a reel, cropped to 9:16"
        : `Members see it as a reel at ${label}`;
  } else if (ratio < ASPECT_MIN) {
    // Not a video and not a photo: nothing measurable reaches here today, but
    // the classic clamp stays the honest answer if anything ever does.
    membersSee = "Members see it cropped to 4:5";
  } else if (ratio > ASPECT_MAX) {
    membersSee = "Members see it cropped to 1.91:1";
  } else {
    membersSee = `Members see it at ${label}`;
  }

  return `${width}×${height} · ${orientation} ${label} · ${membersSee}`;
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
