// Shared types for the Posts library screen (ENG-177 / T7).
// Column names mirror the DB / T5's `GET /api/admin/posts` select:
// post.{type,status,title,body,like_count,published_at,scheduled_for} plus the
// embedded horse + source_trainer joins. No owner PII is ever selected.

import type { SubjectLabel } from "@/lib/posts/subject";

export type PostStatus = "draft" | "scheduled" | "published" | "unpublished";
export type StatusFilter = "all" | PostStatus;

export type HorseEmbed = {
  display_name: string | null;
  racing_name: string | null;
  photo_url: string | null;
};
export type TrainerEmbed = { name: string | null };

/** A row as returned by the list read (mirrors T5's GET select, + horse photo). */
export type PostRow = {
  id: string;
  /**
   * WHO the post is posted as (ENG-1269 / B1's column). Typed as the loose
   * `string | null` a raw row really is — `subjectLabel` normalises it — so an
   * older build reading a newer value renders a horse post rather than
   * crashing on a union it does not know.
   */
  subject: string | null;
  /** Nullable since B1: a trainer or StablePass post has no horse. */
  horse_id: string | null;
  /** FK to `post_byline(name)` — set on StablePass posts only. */
  byline: string | null;
  type: string;
  status: PostStatus;
  title: string | null;
  /**
   * The editorial category, FK to `post_label(name)` (ENG-978). Since ENG-979
   * this is what names the row in the library — see `mapPostRow`.
   */
  label: string | null;
  body: string | null;
  media_url: string | null;
  mux_playback_id: string | null;
  /** Private post-media object path for the baked poster (ENG-823/825). */
  poster_url: string | null;
  /** Seconds of the chosen poster frame, or null when default/unset (ENG-823). */
  poster_time_s: number | null;
  like_count: number | null;
  published_at: string | null;
  scheduled_for: string | null;
  created_at: string;
  // PostgREST embeds resolve to an object (to-one) — typed as object|array to
  // stay robust to the join shape.
  horse: HorseEmbed | HorseEmbed[] | null;
  trainer: TrainerEmbed | TrainerEmbed[] | null;
};

/** The presentational view-model the table renders (pure, prop-injectable). */
export type PostView = {
  id: string;
  title: string;
  excerpt: string;
  /**
   * The subject cell, pre-formatted by the ONE formatter
   * (`lib/posts/subject.ts#subjectLabel`). Replaces the old
   * `horseName`/`trainerName` pair: those two fields could only ever describe
   * a horse post, and every surface re-joined them slightly differently.
   */
  subject: SubjectLabel;
  thumbUrl: string | null;
  /** Raw post.type — used to gate video-only poster edit (ENG-825). */
  type: string;
  typeLabel: string;
  status: PostStatus;
  statusLabel: string;
  statusPillClass: string;
  // Raw instants for the "Published" column — the wall-clock label is formatted
  // client-side, in the operator's browser TZ, by <LocalTime kind="when"> (was a
  // preformatted server-TZ `whenLabel` string). Which one is shown depends on
  // `status` (see `whenIso` in ./format).
  publishedAt: string | null;
  scheduledFor: string | null;
  /** null → no engagement to show (draft / scheduled). */
  likeCount: number | null;
  editHref: string;
  /**
   * Signed Mux HLS URL for video posts with a ready asset (ENG-825). Null when
   * not video, asset not ready, or signing is off. Minted server-side only.
   */
  playbackUrl: string | null;
  /** Current poster frame seconds, or null. */
  posterTimeS: number | null;
};

export type StatusCounts = Record<StatusFilter, number>;
