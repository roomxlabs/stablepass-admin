// Client-side network layer for Compose. Kept apart from the component so it
// can be mocked wholesale in the component test.
//
// Guardrail (media split, §5): the file BYTES never transit our server. The
// BFF `POST /api/admin/posts` only mints the draft + a direct-upload target;
// the browser then PUTs the bytes straight to Mux (video) or Supabase Storage
// (photo). Every BFF call is admin-gated server-side by `requireAdmin()`.
import { supabaseBrowser } from "@/lib/supabase/client";
import type { CreateDraftResponse, MediaType } from "./types";

async function readData<T>(res: Response): Promise<T> {
  const json = (await res.json().catch(() => null)) as
    | { data?: T; error?: { message?: string } }
    | null;
  if (!res.ok) {
    throw new Error(json?.error?.message ?? `Request failed (${res.status}).`);
  }
  return (json?.data ?? null) as T;
}

/**
 * Create the draft + get its direct-upload target. `POST /api/admin/posts` → 202.
 *
 * `type` is passed straight through, unchanged, to the route — the operator's
 * explicit choice from step 2, never anything this layer derives. A `text`
 * draft carries its `body` (the route requires a non-empty one) and comes back
 * with NO upload target, which is why `CreateDraftResponse.uploadUrl` is
 * optional.
 */
export async function createDraft(input: {
  horseId: string;
  type: MediaType;
  sourceTrainerId: string;
  title?: string;
  body?: string;
  /** ENG-745 — one of the 13 presets, or null for no category. */
  label?: string | null;
  /**
   * ENG-748 — how many photo upload targets to mint (1..10). Photo posts only;
   * the route 400s anything above 1 for another type. Omitted means 1, which is
   * what keeps every pre-existing caller byte-identical.
   */
  photoCount?: number;
}): Promise<CreateDraftResponse> {
  const res = await fetch("/api/admin/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return readData<CreateDraftResponse>(res);
}

/** Persist editable fields (title, caption `body`, `source_trainer_id` byline). PATCH. */
export async function patchPost(
  id: string,
  patch: {
    body?: string;
    sourceTrainerId?: string;
    title?: string | null;
    /**
     * ENG-745. `null` CLEARS the category; omitting the key leaves the row's
     * label untouched. The route distinguishes the two, so this must not be
     * collapsed to `string | undefined`.
     */
    label?: string | null;
    /**
     * ENG-748 — the WHOLE ordered photo set, in display order, as bare Storage
     * object paths. The route replaces the post's `post_media` rows with these
     * (contiguous `sort_order` from 0) and moves `post.media_url` to match
     * position 0.
     *
     * It is a full replacement, not a delta: sending a partial list deletes the
     * photos you left out. Omit the key entirely to leave the set alone, which
     * is what every non-photo save does.
     */
    media?: string[];
  },
): Promise<void> {
  const res = await fetch(`/api/admin/posts/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  await readData(res);
}

export async function publishPost(id: string): Promise<void> {
  const res = await fetch(`/api/admin/posts/${id}/publish`, { method: "POST" });
  await readData(res);
}

/** An Error carrying the envelope's error `code` so the UI can branch per code. */
export class ApiError extends Error {
  code?: string;
  status: number;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Schedule (or re-schedule) a draft/scheduled post. Surfaces the endpoint's
 * error `code` (`scheduled_for_in_past`, `validation_failed`, `invalid_status`)
 * on the thrown `ApiError` so Compose can render a per-code inline message.
 */
export async function schedulePost(id: string, scheduledFor: string): Promise<void> {
  const res = await fetch(`/api/admin/posts/${id}/schedule`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scheduledFor }),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null;
    throw new ApiError(
      json?.error?.message ?? `Schedule failed (${res.status}).`,
      res.status,
      json?.error?.code,
    );
  }
}

/** Discard a draft (hard delete, draft-only per guardrail §2). DELETE → 204. */
export async function discardDraft(id: string): Promise<void> {
  const res = await fetch(`/api/admin/posts/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) {
    const json = (await res.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(json?.error?.message ?? `Discard failed (${res.status}).`);
  }
}

/** PUT the finished video straight to the Mux one-time upload URL. */
export function uploadVideoToMux(
  uploadUrl: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed (${xhr.status}).`));
    xhr.onerror = () => reject(new Error("Upload failed — check your connection."));
    xhr.send(file);
  });
}

/** Upload a photo straight to Supabase Storage via the signed-upload token. */
export async function uploadPhotoToStorage(args: {
  bucket: string;
  path: string;
  token: string;
  file: File;
}): Promise<void> {
  const sb = supabaseBrowser();
  const { error } = await sb.storage
    .from(args.bucket)
    .uploadToSignedUrl(args.path, args.token, args.file);
  if (error) throw new Error(error.message);
}
