// Presentation helpers for the Posts library (screens/04-posts.html).
// Kept apart from the components so the mapping + filter model are unit-testable
// without rendering.

import { buildListHref, type SortDir } from "../list-href";
import { POST_SORT_DEFAULT_DIR, type PostSort } from "@/lib/posts/sort";
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
    title: row.title?.trim() || "Untitled post",
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

/**
 * Build a `/posts` URL preserving the active filter + search + sort across nav.
 *
 * Now a thin wrapper over the shared `buildListHref` (ENG-963) so posts,
 * horses and trainers drop empty params identically. `sort`/`dir` ride the same
 * rails as the filters, which is what makes a sorted view refreshable and
 * shareable.
 *
 * `dir` is only emitted alongside a `sort` — `?dir=asc` on its own orders
 * nothing and would just be noise in a shared link.
 */
export function buildPostsHref(p: {
  status?: StatusFilter;
  q?: string;
  horseId?: string;
  trainerId?: string;
  sort?: PostSort | "";
  dir?: SortDir;
  offset?: number;
}): string {
  return buildListHref("/posts", {
    status: p.status && p.status !== "all" ? p.status : "",
    q: p.q,
    horseId: p.horseId,
    trainerId: p.trainerId,
    sort: p.sort,
    dir: p.sort ? p.dir : "",
    offset: p.offset,
  });
}

/**
 * The columns the Posts table can be sorted by, in render order, with the
 * direction a first click produces. Kept here (not in the component) so the
 * header set is unit-testable and stays in step with `lib/posts/sort.ts`.
 */
export const POST_SORT_COLUMNS: { column: PostSort; label: string; defaultDir: SortDir }[] = [
  { column: "horse", label: "Horse / trainer", defaultDir: POST_SORT_DEFAULT_DIR.horse },
  { column: "status", label: "Status", defaultDir: POST_SORT_DEFAULT_DIR.status },
  { column: "published", label: "Published", defaultDir: POST_SORT_DEFAULT_DIR.published },
  { column: "engagement", label: "Engagement", defaultDir: POST_SORT_DEFAULT_DIR.engagement },
];
