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

/** Create the draft + get its direct-upload target. `POST /api/admin/posts` → 202. */
export async function createDraft(input: {
  horseId: string;
  type: MediaType;
  sourceTrainerId: string;
  title?: string;
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
  patch: { body?: string; sourceTrainerId?: string; title?: string | null },
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
