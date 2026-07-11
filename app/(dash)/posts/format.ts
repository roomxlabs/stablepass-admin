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

/** "2h ago" / "yesterday" / "3 days ago" / "5 Jul" — relative to `now`. */
export function relTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const mins = Math.round((now.getTime() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

/** Future schedule label, e.g. "Sat 6:00am". */
export function schedLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-AU", { weekday: "short", hour: "numeric", minute: "2-digit" });
}

export function whenLabel(row: Pick<PostRow, "status" | "published_at" | "scheduled_for">): string {
  if (row.status === "scheduled") return row.scheduled_for ? schedLabel(row.scheduled_for) : "—";
  if (row.status === "published" || row.status === "unpublished")
    return row.published_at ? relTime(row.published_at) : "—";
  return "—";
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
    typeLabel: typeLabel(row.type),
    status: row.status,
    statusLabel: meta.label,
    statusPillClass: meta.pill,
    whenLabel: whenLabel(row),
    likeCount: engaged ? row.like_count ?? 0 : null,
    // Editing a post happens in Compose (T6); the PATCH endpoint is T5's.
    editHref: `/compose?id=${row.id}`,
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
