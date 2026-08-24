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

// The public bucket's `allowed_mime_types` is exactly these three (W7). An
// extension outside the set can never be stored, so we normalise to jpg rather
// than attempting an upload the bucket will reject.
const EXT_CONTENT_TYPE: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
const ALLOWED_CONTENT_TYPES = new Set(Object.values(EXT_CONTENT_TYPE));

export type MarketingPhotoResult =
  // `path` is the value that should now be stored in trainer.marketing_photo_path.
  // On failure it is the UNCHANGED previous value, so a failed copy never nulls a
  // path that still points at a live object.
  { ok: true; path: string | null } | { ok: false; path: string | null; message: string };

const COPY_FAILED =
  "Saved, but the photo has not been published to the marketing site yet. Retry publishing the photo.";
const REMOVE_FAILED =
  "Saved and hidden from the marketing site, but the published photo could not be removed. Retry removing it.";

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

async function removeObject(sb: SupabaseClient, path: string): Promise<boolean> {
  const { error } = await sb.storage.from(MARKETING_PHOTO_BUCKET).remove([path]);
  return !error;
}

/**
 * Copy the trainer's private photo into the public bucket.
 *
 * `previousPath` is the currently-published object (if any). When the new copy
 * lands at a DIFFERENT path — which happens whenever the replacement photo has a
 * different extension — the old object is deleted, otherwise a jpg→png swap
 * would leave the previous image anonymously fetchable at its old URL forever.
 */
export async function publishMarketingPhoto(
  sb: SupabaseClient,
  trainerId: string,
  privatePath: string | null,
  previousPath: string | null = null,
): Promise<MarketingPhotoResult> {
  // Toggle ON with no photo yet is explicitly allowed: the row carries a null
  // path and the site renders the initials disc (W7 contract). Any previously
  // published object is still cleaned up so it cannot outlive its source.
  if (!privatePath) {
    if (previousPath && !(await removeObject(sb, previousPath)))
      return { ok: false, path: previousPath, message: REMOVE_FAILED };
    return { ok: true, path: null };
  }

  const ext = marketingExt(privatePath);
  const target = marketingPhotoPathFor(trainerId, privatePath);

  try {
    const signed = await signPhoto(sb, TRAINER_PHOTO_BUCKET, privatePath);
    if (!signed) return { ok: false, path: previousPath, message: COPY_FAILED };

    const res = await fetch(signed);
    if (!res.ok) return { ok: false, path: previousPath, message: COPY_FAILED };
    const blob = await res.blob();

    const { error } = await sb.storage.from(MARKETING_PHOTO_BUCKET).upload(target, blob, {
      upsert: true,
      contentType: ALLOWED_CONTENT_TYPES.has(blob.type) ? blob.type : EXT_CONTENT_TYPE[ext],
    });
    if (error) return { ok: false, path: previousPath, message: COPY_FAILED };

    if (previousPath && previousPath !== target && !(await removeObject(sb, previousPath)))
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
  publishedPath: string | null,
): Promise<MarketingPhotoResult> {
  if (!publishedPath) return { ok: true, path: null };
  try {
    if (!(await removeObject(sb, publishedPath)))
      return { ok: false, path: publishedPath, message: REMOVE_FAILED };
    return { ok: true, path: null };
  } catch {
    return { ok: false, path: publishedPath, message: REMOVE_FAILED };
  }
}
