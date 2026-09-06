// Presentation helpers for the Posts library (screens/04-posts.html).
// Kept apart from the components so the mapping + filter model are unit-testable
// without rendering.

import type { PostRow, PostStatus, PostView, StatusFilter } from "./types";

// Filter chips, in mockup order. The chip key doubles as the `?status=` value
// (T5's GET filter); "all" clears the filter.
export const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "published", label: "Published" },
  { key: "scheduled", label: "Scheduled" },
  { key: "draft", label: "Drafts" },
  { key: "unpublished", label: "Unpublished" },
];

export const POST_STATUSES: PostStatus[] = ["published", "scheduled", "draft", "unpublished"];

export function isPostStatus(v: unknown): v is PostStatus {
  return typeof v === "string" && (POST_STATUSES as string[]).includes(v);
}

/** Coerce a raw `?status=` param to a valid filter, defaulting to "all". */
export function parseStatusFilter(v: unknown): StatusFilter {
  return isPostStatus(v) ? v : "all";
}

const STATUS_META: Record<PostStatus, { label: string; pill: string }> = {
  published: { label: "Published", pill: "pill green dot" },
  scheduled: { label: "Scheduled", pill: "pill amber dot" },
  draft: { label: "Draft", pill: "pill" },
  unpublished: { label: "Unpublished", pill: "pill red dot" },
};
export function statusMeta(s: PostStatus): { label: string; pill: string } {
  return STATUS_META[s];
}

const TYPE_LABELS: Record<string, string> = {
  video: "Video",
  photo: "Photo",
  text: "Text",
  voice: "Voice",
  news: "News",
};
export function typeLabel(t: string): string {
  return TYPE_LABELS[t] ?? (t ? t[0].toUpperCase() + t.slice(1) : "—");
}

function firstEmbed<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/**
 * Which instant the "Published" column shows, by status:
 *   - scheduled              → its `scheduledFor`
 *   - published/unpublished  → its `publishedAt`
 *   - draft (or missing)     → none (the row renders "—")
 *
 * This is the status→field *mapping* only. The wall-clock formatting that used
 * to live here (`relTime`/`schedLabel`, hardcoded "en-AU" + server TZ) now lives
 * in <LocalTime kind="when">, which renders `iso` in the operator's browser TZ.
 */
export function whenIso(v: Pick<PostView, "status" | "publishedAt" | "scheduledFor">): string | null {
  if (v.status === "scheduled") return v.scheduledFor;
  if (v.status === "published" || v.status === "unpublished") return v.publishedAt;
  return null;
}

export function mapPostRow(row: PostRow): PostView {
  const horse = firstEmbed(row.horse);
  const trainer = firstEmbed(row.trainer);
  const meta = statusMeta(row.status);
  const engaged = row.status === "published" || row.status === "unpublished";
  return {
    id: row.id,
    // ENG-979 — the LABEL names the row, not the old free-text title.
    //
    // Compose now offers ONE field (a picker over `post_label` + Add new), so
    // `label` is what an operator actually sets on a new post and `title` is a
    // legacy column with no input behind it. Mel's complaint was that the
    // library said "Untitled post" for posts she had named, so she could not
    // tell them apart without opening each one.
    //
    // `title` is kept as a DISPLAY-ONLY fallback, deliberately. Posts written
    // before this ticket carry a typed `title` and a null `label`; reading
    // label-only would have regressed those rows to "Untitled post" — the very
    // symptom this ticket exists to remove — and the only alternative was a
    // backfill, which is a data write the human owner has not approved (the
    // ticket says to ask first, and Mel has live posts in this state). A read
    // fallback fixes the symptom, writes nothing, and leaves the backfill
    // decision open. See the PR body.
    //
    // So "Untitled post" now survives only for a post with NO label and NO
    // title — genuinely unnamed, rather than merely unlabelled.
    title: row.label?.trim() || row.title?.trim() || "Untitled post",
    excerpt: (row.body ?? "").trim(),
    horseName: horse?.display_name || horse?.racing_name || "Unassigned",
    trainerName: trainer?.name ?? null,
    thumbUrl: horse?.photo_url ?? null,
    type: row.type,
    typeLabel: typeLabel(row.type),
    status: row.status,
    statusLabel: meta.label,
    statusPillClass: meta.pill,
    // Raw instants — formatted client-side in the browser TZ by <LocalTime>.
    publishedAt: row.published_at,
    scheduledFor: row.scheduled_for,
    likeCount: engaged ? row.like_count ?? 0 : null,
    // Editing a post happens in Compose (T6); the PATCH endpoint is T5's.
    editHref: `/compose?id=${row.id}`,
    // Filled by the page after signing (playback + poster) — mapPostRow leaves
    // these null so unit tests of the pure mapper stay DB-free.
    playbackUrl: null,
    posterTimeS:
      typeof row.poster_time_s === "number" && Number.isFinite(row.poster_time_s)
        ? row.poster_time_s
        : null,
  };
}

/** Build a `/posts` URL preserving the active filter + search across nav. */
export function buildPostsHref(p: {
  status?: StatusFilter;
  q?: string;
  horseId?: string;
  offset?: number;
}): string {
  const params = new URLSearchParams();
  if (p.status && p.status !== "all") params.set("status", p.status);
  if (p.q) params.set("q", p.q);
  if (p.horseId) params.set("horseId", p.horseId);
  if (p.offset && p.offset > 0) params.set("offset", String(p.offset));
  const s = params.toString();
  return s ? `/posts?${s}` : "/posts";
}
