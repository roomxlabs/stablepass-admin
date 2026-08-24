import type { SupabaseClient } from "@supabase/supabase-js";
import { TRAINER_PHOTO_BUCKET, signPhoto } from "@/lib/storage/photos";

// ENG-766 (W8) — copying a trainer's photo into the PUBLIC `marketing-photos`
// bucket so stablepass.co can serve it unsigned.
//
// This is the one place in the admin app that writes to a public bucket, and it
// is a deliberate, narrow exception to the private-media norm (see the W7
// migration 20260819120004_public_trainer.sql, which documents it). Rules that
// hold here and nowhere else:
//
//   * The ONLY thing that may be copied is a trainer's own marketing-approved
//     profile photo. Nothing from `trainer_contact` — or any other bucket —
//     goes near this flow.
//   * The copy is BROWSER-SIDE and direct-to-storage in both directions: we read
//     the private original through the existing signed-read helper and PUT the
//     bytes straight to the public bucket. Bytes never transit our server, which
//     is the same guardrail the compose upload path follows.
//   * The bucket is admin-write-only (its RLS policies require is_admin(), which
//     in turn requires an AAL2 session), so these calls only succeed for a real
//     signed-in admin.
//
// Kept out of TrainerForm.tsx on purpose: this is the risky half of the ticket,
// and as a standalone module it can be unit-tested against a fake client without
// a DOM (see marketingPhoto.test.ts).

export const MARKETING_PHOTO_BUCKET = "marketing-photos";

// The public bucket's `allowed_mime_types` is exactly these three (W7).
const EXT_CONTENT_TYPE: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
const ALLOWED_CONTENT_TYPES = new Set(Object.values(EXT_CONTENT_TYPE));
const MARKETING_EXTS = Object.keys(EXT_CONTENT_TYPE);

export type MarketingPhotoResult =
  // `path` is the value that should now be stored in trainer.marketing_photo_path.
  // On failure it is the UNCHANGED previous value, so a failed copy never nulls a
  // path that still points at a live object.
  { ok: true; path: string | null } | { ok: false; path: string | null; message: string };

const COPY_FAILED =
  "Saved, but the photo has not been published to the marketing site yet. Retry publishing the photo.";
const REMOVE_FAILED =
  "Saved and hidden from the marketing site, but the published photo could not be removed. Retry removing it.";

// A storage rejection is usually PERMANENT (too large, wrong format), so the
// reason is shown rather than an unqualified "retry" the admin could loop on.
const copyFailedMessage = (reason?: string) =>
  reason ? `Saved, but the photo could not be published to the marketing site: ${reason}` : COPY_FAILED;
const unsupportedMessage = (type: string) =>
  `Saved, but the photo could not be published: ${type} is not a supported format for the marketing site. Use a JPEG, PNG or WebP.`;

// The stored private value is a bare object path (e.g. `chris-waller-1723.jpg`).
export function marketingExt(privatePath: string): string {
  const file = privatePath.split("?")[0].split("/").pop() ?? "";
  const dot = file.lastIndexOf(".");
  const ext = dot === -1 ? "" : file.slice(dot + 1).toLowerCase();
  return Object.prototype.hasOwnProperty.call(EXT_CONTENT_TYPE, ext) ? ext : "jpg";
}

// One object per trainer, keyed by id — so re-publishing overwrites in place
// instead of accumulating copies. The trainer id is a uuid, so this can never
// produce the leading `/` or `..` that trainer.marketing_photo_path's CHECK
// constraint (and the PATCH route) reject.
export function marketingPhotoPathFor(trainerId: string, privatePath: string): string {
  return `trainers/${trainerId}.${marketingExt(privatePath)}`;
}

/**
 * Every public key this trainer could possibly occupy.
 *
 * Removal must NOT be driven by `trainer.marketing_photo_path`, because the two
 * ways that pointer can be lost are exactly the two ways an object gets orphaned:
 *
 *   1. The upload lands but the PATCH that records the path fails. The DB then
 *      holds NULL while the object is live, so a later un-publish has nothing to
 *      delete and silently no-ops.
 *   2. A replacement photo changes the extension and the delete of the old key
 *      fails. The path advances to the new key, so the old one is forgotten and
 *      a retry — seeing previous === target — skips it.
 *
 * The key is fully determined by the trainer id plus one of four allowed
 * extensions, so the whole set is knowable without the database. Sweeping it is
 * idempotent (Supabase `remove()` ignores keys that do not exist) and costs one
 * round-trip, which closes both holes at once. W7's migration added the admin
 * delete policy specifically so consent withdrawal has a path; losing that path
 * is the failure this guards against.
 */
export function marketingPhotoCandidates(trainerId: string): string[] {
  return MARKETING_EXTS.map((ext) => `trainers/${trainerId}.${ext}`);
}

async function removeKeys(sb: SupabaseClient, keys: string[]): Promise<boolean> {
  if (keys.length === 0) return true;
  const { error } = await sb.storage.from(MARKETING_PHOTO_BUCKET).remove(keys);
  return !error;
}

// Delete every public object for this trainer except `keep` (the one just
// uploaded, if any).
async function sweep(sb: SupabaseClient, trainerId: string, keep: string | null): Promise<boolean> {
  return removeKeys(
    sb,
    marketingPhotoCandidates(trainerId).filter((p) => p !== keep),
  );
}

/** Copy the trainer's private photo into the public bucket. */
export async function publishMarketingPhoto(
  sb: SupabaseClient,
  trainerId: string,
  privatePath: string | null,
  previousPath: string | null = null,
): Promise<MarketingPhotoResult> {
  // Toggle ON with no photo yet is explicitly allowed: the row carries a null
  // path and the site renders the initials disc (W7 contract). Any previously
  // published object is still swept so it cannot outlive its source.
  if (!privatePath) {
    if (!(await sweep(sb, trainerId, null)))
      return { ok: false, path: previousPath, message: REMOVE_FAILED };
    return { ok: true, path: null };
  }

  const target = marketingPhotoPathFor(trainerId, privatePath);

  try {
    const signed = await signPhoto(sb, TRAINER_PHOTO_BUCKET, privatePath);
    if (!signed) return { ok: false, path: previousPath, message: COPY_FAILED };

    const res = await fetch(signed);
    if (!res.ok) return { ok: false, path: previousPath, message: COPY_FAILED };
    const blob = await res.blob();

    // REFUSE an unexpected format rather than relabelling it. The public bucket
    // declares allowed_mime_types for a stated reason (W7: an image/svg+xml or
    // text/html object would be a live document on that public origin), and the
    // private bucket it is copied FROM sets no such restriction. Passing a
    // known-good contentType for unknown bytes would launder exactly the case
    // the allow-list exists to stop, so the allow-list is honoured here too.
    if (blob.type && !ALLOWED_CONTENT_TYPES.has(blob.type))
      return { ok: false, path: previousPath, message: unsupportedMessage(blob.type) };

    const { error } = await sb.storage.from(MARKETING_PHOTO_BUCKET).upload(target, blob, {
      upsert: true,
      contentType: blob.type || EXT_CONTENT_TYPE[marketingExt(privatePath)],
    });
    // Surface the storage error itself: "Payload too large" (the public bucket
    // caps at 10 MB while the private one has no limit) and "mime type not
    // allowed" are both permanent, and a bare retry prompt would send the admin
    // round a loop that can never succeed.
    if (error) return { ok: false, path: previousPath, message: copyFailedMessage(error.message) };

    // Sweep every OTHER key for this trainer, not just the recorded previous
    // one — see marketingPhotoCandidates.
    if (!(await sweep(sb, trainerId, target)))
      return { ok: false, path: target, message: REMOVE_FAILED };

    return { ok: true, path: target };
  } catch {
    // Network drop mid-copy. The profile save has already succeeded by this
    // point; the caller surfaces this as a retryable warning and never rolls back.
    return { ok: false, path: previousPath, message: COPY_FAILED };
  }
}

/**
 * Take the trainer off the marketing site: delete the public object and report
 * that the stored path should become null.
 *
 * If the delete fails the path is deliberately KEPT, because the object is still
 * live and a retry needs to know what to remove. The trainer is already gone from
 * `public_trainer` at this point (the flag is written by the profile save), so the
 * site is correct either way — this only cleans up the orphaned object.
 */
export async function unpublishMarketingPhoto(
  sb: SupabaseClient,
  trainerId: string,
  publishedPath: string | null = null,
): Promise<MarketingPhotoResult> {
  // Deliberately sweeps even when the stored path is null. A null path does NOT
  // prove there is no public object — it is exactly the state left behind when
  // an upload succeeded but recording the path did not, and treating it as
  // "nothing to do" is what let an object outlive its trainer's consent.
  try {
    if (!(await sweep(sb, trainerId, null)))
      return { ok: false, path: publishedPath, message: REMOVE_FAILED };
    return { ok: true, path: null };
  } catch {
    return { ok: false, path: publishedPath, message: REMOVE_FAILED };
  }
}
