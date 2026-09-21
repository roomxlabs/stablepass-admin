// Client-side network layer for Compose. Kept apart from the component so it
// can be mocked wholesale in the component test.
//
// Guardrail (media split, §5): the file BYTES never transit our server. The
// BFF `POST /api/admin/posts` only mints the draft + a direct-upload target;
// the browser then PUTs the bytes straight to Mux (video) or Supabase Storage
// (photo). Every BFF call is admin-gated server-side by `requireAdmin()`.
import { supabaseBrowser } from "@/lib/supabase/client";
import type { CreateDraftResponse, MediaType, PhotoUploadTarget, Subject } from "./types";

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
  /**
   * ENG-1268 — who the post is posted AS.
   *
   * OPTIONAL, and omitted means `horse`: a horse post sends no `subject` key
   * at all, so the request this endpoint receives for the legacy flow is
   * byte-identical to the one it received before this ticket. Nothing
   * downstream can tell the subject picker shipped.
   */
  subject?: Subject;
  /** Required for `horse`; must be ABSENT for trainer/stablepass. */
  horseId?: string;
  type: MediaType;
  /** Required for `horse` and `trainer`; must be ABSENT for stablepass. */
  sourceTrainerId?: string;
  /**
   * ENG-1268 — the StablePass byline NAME (not a `post_byline` id). Required
   * for `stablepass`, rejected for the other two.
   */
  byline?: string;
  title?: string;
  body?: string;
  /** ENG-745 — one of the presets in `lib/posts/labels.ts`, or null for no category. */
  label?: string | null;
  /**
   * ENG-748 — how many photo upload targets to mint (1..10). Photo posts only;
   * the route 400s anything above 1 for another type. Omitted means 1, which is
   * what keeps every pre-existing caller byte-identical.
   */
  photoCount?: number;
  /**
   * ENG-824 — seconds into the video for the Mux poster bake. Snake_case on
   * the wire to match the column. Omit when unset (mirror `labelPatch`); only
   * a video post ever sends it.
   */
  poster_time_s?: number | null;
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
    /**
     * ENG-1268 — the StablePass byline NAME. Editable for a `stablepass` post
     * only; the route 400s it for any other subject, and 400s a retired name.
     *
     * ABSENT unless the operator actually moved the picker — the same rule
     * `label` follows, and for the same reason: a post can carry a RETIRED
     * byline legitimately, and re-sending the displayed value unconditionally
     * is how a mis-rendered control overwrites a value nobody touched.
     */
    byline?: string;
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
    /**
     * ENG-824 — poster frame time in seconds. Omit to leave the column alone;
     * a number sets it. Create usually races ahead of the scrubber, so the
     * publish PATCH (and the immediate patch on "Use this frame") is how a
     * picked time reaches the row before Mux `asset.ready`.
     */
    poster_time_s?: number | null;
  },
): Promise<void> {
  const res = await fetch(`/api/admin/posts/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  await readData(res);
}

/**
 * ENG-1266 — mint `count` MORE direct-upload targets on an existing photo post.
 * `POST /api/admin/posts/:id/photo-uploads` → 200.
 *
 * This is what makes "Add more photos" possible at all: `createDraft` mints
 * every target up front from `photoCount`, so appending to a draft (or to a
 * post being edited) has to ask for new slots separately.
 *
 * The client sends a COUNT and never a path — the route derives every slot
 * path from the post id, so nothing here can aim an upload anywhere else.
 */
export async function requestPhotoUploads(
  postId: string,
  count: number,
  /**
   * What the browser knows that the server cannot see yet — both plain
   * INTEGERS, never paths, so the guardrail ("the route derives every path from
   * the post id") is untouched.
   *
   * `afterSlot` — the highest upload ordinal this session has EVER held for
   * this post, including slots whose bytes are still uploading or failed, and
   * including slots whose tile the operator has since REMOVED. Not "what the
   * strip is holding now": removing a tile does not abort its PUT, so a slot
   * that has left the strip can still be live, and a hint derived from the
   * survivors would hand it back. The server floors the answer at its own
   * derivation, so a wrong or missing hint can only skip ordinals, never
   * re-issue one — but its floor cannot see an in-flight object, which is
   * exactly the gap this hint exists to cover.
   *
   * `keeping` — how many photos the operator will actually keep. The server
   * would otherwise count ORPHANED objects (a removed photo's bytes are left in
   * place by design), which makes replacing a photo on a full post impossible.
   */
  holding?: { afterSlot: number; keeping: number },
): Promise<PhotoUploadTarget[]> {
  const res = await fetch(`/api/admin/posts/${postId}/photo-uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ count, ...(holding ?? {}) }),
  });
  const data = await readData<{ uploads?: PhotoUploadTarget[] }>(res);
  return data?.uploads ?? [];
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

/**
 * ENG-979 — Add-new: create an editorial category and get it back.
 *
 * Returns the row whether it was created (201) or already existed (200): the
 * route is idempotent by folded name, so an operator who retypes a category
 * they already have ends up selecting the one they have instead of getting an
 * error. The caller only needs `name` — that string is what `post.label`
 * stores, and no `post_label` id is ever sent to a member surface.
 */
export async function createPostLabel(name: string): Promise<{ name: string }> {
  const res = await fetch("/api/admin/post-labels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return readData<{ name: string }>(res);
}

/**
 * ENG-1268 — Add-new for the StablePass byline picker (A2's route).
 *
 * Returns `{id, name}` rather than just the name, because unlike a label a
 * byline's RETIRE action needs its id — the picker keeps both.
 *
 * NOT idempotent the way `createPostLabel` is: A2 locked a live duplicate to
 * 409 ("that name is taken") deliberately, while a duplicate whose only row is
 * RETIRED is un-retired and returned with the SAME id. So re-adding a byline
 * an admin previously retired restores it rather than minting a twin — which
 * is why the caller must take the returned id and not assume a new one.
 */
export async function createByline(name: string): Promise<{ id: string; name: string }> {
  const res = await fetch("/api/admin/post-bylines", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return readData<{ id: string; name: string }>(res);
}

/**
 * ENG-1268 — retire a byline (A2's `DELETE /api/admin/post-bylines/:id`).
 *
 * RETIRE, NEVER DELETE (guardrail 2). `post.byline` stores the NAME and is
 * FK'd `on delete restrict`, so every post already carrying this byline keeps
 * its text unchanged; retiring only hides the name from this picker for NEW
 * posts. That is also why the edit path has to union a retired value back into
 * its options — see ComposeScreen's `bylineOptions`.
 */
export async function retireByline(id: string): Promise<void> {
  const res = await fetch(`/api/admin/post-bylines/${id}`, { method: "DELETE" });
  await readData(res);
}

/**
 * ENG-1268 — retire an editorial label (A2's `DELETE /api/admin/post-labels/:id`).
 *
 * The route refuses a BUILTIN with 409, and be's `post_label_pin_builtin`
 * trigger refuses it again — but the picker never offers the action on one in
 * the first place, so a 409 here means the row's `is_builtin` changed under us.
 */
export async function retireLabel(id: string): Promise<void> {
  const res = await fetch(`/api/admin/post-labels/${id}`, { method: "DELETE" });
  await readData(res);
}
