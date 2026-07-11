import type { SupabaseClient } from "@supabase/supabase-js";

// Server-side data access for the admin Trainers list. Kept out of the page
// component so it can be unit-tested against the Supabase fake. Uses flat,
// per-table queries (no PostgREST embedding) merged in JS — deriving horse
// count, last-post recency and the primary internal contact per trainer.
//
// trainer_contact is ADMIN-ONLY (guardrail §3): its email is read here only to
// render the admin-gated list, never on any member surface.

export type TrainerStatus = "active" | "onboarding";

export type TrainerRow = {
  id: string;
  name: string;
  displayName: string;
  slug: string;
  stableName: string | null;
  location: string | null;
  status: TrainerStatus;
  photoUrl: string | null;
  initials: string;
  contactEmail: string | null;
  horseCount: number;
  lastPostAt: string | null;
};

export type TrainerListParams = { status?: string | null; q?: string | null };

export type TrainerList = {
  rows: TrainerRow[];
  counts: { all: number; active: number; onboarding: number };
};

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function timeAgo(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "-";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "-";
  const mins = Math.floor((now.getTime() - then) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return new Date(iso).toLocaleDateString();
}

// PostgREST `.or()` grammar treats `,()` as structural; strip them from free
// text so a search term can never produce a malformed filter (mirrors posts).
function sanitize(q: string): string {
  return q.replace(/[(),]/g, " ").trim();
}

export async function listTrainers(
  sb: SupabaseClient,
  params: TrainerListParams = {},
): Promise<TrainerList> {
  const status = params.status === "active" || params.status === "onboarding" ? params.status : null;
  const text = params.q ? sanitize(params.q) : "";

  let query = sb
    .from("trainer")
    .select("id,name,display_name,slug,stable_name,location,status,photo_url")
    .order("name", { ascending: true });
  if (status) query = query.eq("status", status);
  if (text) {
    const like = `%${text}%`;
    query = query.or(
      `name.ilike.${like},display_name.ilike.${like},stable_name.ilike.${like},location.ilike.${like}`,
    );
  }

  // Roster counts for the filter chips are unfiltered (they show the whole set).
  const [{ data: trainers }, { data: statuses }, { data: horses }, { data: posts }, { data: contacts }] =
    await Promise.all([
      query,
      sb.from("trainer").select("status"),
      sb.from("horse").select("trainer_id"),
      sb.from("post").select("source_trainer_id,published_at,created_at"),
      sb.from("trainer_contact").select("trainer_id,role,email"),
    ]);

  const horseCounts = new Map<string, number>();
  for (const h of (horses ?? []) as { trainer_id: string }[])
    horseCounts.set(h.trainer_id, (horseCounts.get(h.trainer_id) ?? 0) + 1);

  const lastPost = new Map<string, string>();
  for (const p of (posts ?? []) as { source_trainer_id: string; published_at: string | null; created_at: string }[]) {
    if (!p.source_trainer_id) continue;
    const at = p.published_at ?? p.created_at;
    const cur = lastPost.get(p.source_trainer_id);
    if (!cur || new Date(at) > new Date(cur)) lastPost.set(p.source_trainer_id, at);
  }

  const emails = new Map<string, string>();
  for (const c of (contacts ?? []) as { trainer_id: string; role: string | null; email: string | null }[]) {
    if (!c.email) continue;
    const isTrainerRole = (c.role ?? "").toLowerCase().includes("trainer");
    if (isTrainerRole || !emails.has(c.trainer_id)) emails.set(c.trainer_id, c.email);
  }

  const rows: TrainerRow[] = ((trainers ?? []) as Record<string, string>[]).map((t) => ({
    id: t.id,
    name: t.name,
    displayName: t.display_name ?? t.name,
    slug: t.slug,
    stableName: t.stable_name ?? null,
    location: t.location ?? null,
    status: (t.status as TrainerStatus) ?? "active",
    photoUrl: t.photo_url ?? null,
    initials: initials(t.name),
    contactEmail: emails.get(t.id) ?? null,
    horseCount: horseCounts.get(t.id) ?? 0,
    lastPostAt: lastPost.get(t.id) ?? null,
  }));

  const all = (statuses ?? []) as { status: string }[];
  const counts = {
    all: all.length,
    active: all.filter((s) => s.status === "active").length,
    onboarding: all.filter((s) => s.status === "onboarding").length,
  };

  return { rows, counts };
}
