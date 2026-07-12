import type { SupabaseClient } from "@supabase/supabase-js";

// Photos live in PRIVATE Storage buckets (guardrail #8), so they can only be
// displayed through short-lived SIGNED URLs — never a public URL. Forms store
// the bare object *path* in `photo_url`; every display surface turns that path
// into a signed URL at render time with these helpers.

export const HORSE_PHOTO_BUCKET = "horse-photos";
export const TRAINER_PHOTO_BUCKET = "trainer-photos";

// 1 hour: long enough for a page/session, short enough that a leaked URL expires.
export const PHOTO_SIGN_TTL = 3600;

// A stored value is normally a bare object path. Defensively pass through an
// already-absolute URL (legacy rows, brand assets) untouched instead of trying
// to sign it as a path.
const isAbsoluteUrl = (v: string): boolean => /^(https?:|blob:|data:)/i.test(v);

// Sign a single stored photo value for display. Returns null when there is
// nothing to show or signing fails (missing object / RLS), so callers fall back
// to a placeholder rather than rendering a broken image.
export async function signPhoto(
  sb: SupabaseClient,
  bucket: string,
  value: string | null | undefined,
  ttl: number = PHOTO_SIGN_TTL,
): Promise<string | null> {
  if (!value) return null;
  if (isAbsoluteUrl(value)) return value;
  const { data } = await sb.storage.from(bucket).createSignedUrl(value, ttl);
  return data?.signedUrl ?? null;
}

// Batch variant: one round-trip for a list. Returns a `value -> signed URL` map
// keyed by the ORIGINAL stored value, so a caller can look each row's value up
// directly. Distinct paths only; absolute URLs map to themselves.
export async function signPhotoMap(
  sb: SupabaseClient,
  bucket: string,
  values: ReadonlyArray<string | null | undefined>,
  ttl: number = PHOTO_SIGN_TTL,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const paths: string[] = [];
  for (const v of values) {
    if (!v) continue;
    if (isAbsoluteUrl(v)) out.set(v, v);
    else if (!out.has(v) && !paths.includes(v)) paths.push(v);
  }
  if (paths.length === 0) return out;
  const { data } = await sb.storage.from(bucket).createSignedUrls(paths, ttl);
  for (const item of data ?? []) {
    if (item.path && item.signedUrl) out.set(item.path, item.signedUrl);
  }
  return out;
}
