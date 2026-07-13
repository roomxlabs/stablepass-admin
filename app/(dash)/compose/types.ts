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
 */
export type EditInitial = {
  id: string;
  status: string; // draft | scheduled | published | unpublished
  mediaType: MediaType;
  mediaUrl: string | null;
  caption: string;
  bylineId: string;
  horse: HorseOption;
};
