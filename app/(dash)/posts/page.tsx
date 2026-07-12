import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAdminPage } from "@/lib/auth/admin";
import PostsLibrary from "./PostsLibrary";
import { mapPostRow, parseStatusFilter } from "./format";
import type { PostRow, StatusCounts, StatusFilter } from "./types";
import { HORSE_PHOTO_BUCKET, signPhotoMap } from "@/lib/storage/photos";
import "./posts.css";

// Posts library — screens/04-posts.html. Data-bearing (dash) page: it
// re-asserts requireAdminPage() rather than trusting the layout gate (Next
// renders layout + page in parallel). The list is a Layer-A admin read that
// mirrors T5's GET /api/admin/posts contract (same fields, status/horse/q
// filters, offset pagination); the row *actions* call T5's endpoints. No owner
// PII is selected (guardrail §4).

const PAGE_SIZE = 20;
const POST_FIELDS =
  "id,horse_id,type,status,title,body,like_count,published_at,scheduled_for,created_at," +
  "horse:horse_id(display_name,racing_name,photo_url),trainer:source_trainer_id(name)";

// Resolve free-text `q` into a PostgREST OR clause across post title/body plus
// the joined horse + trainer names — mirrors T5's GET search. The `(),`
// characters are structural in PostgREST's `.or()` grammar, so strip them from
// the free-text term (the same guard T5 uses) to keep a stray comma/paren from
// splicing extra clauses.
async function qOrClause(sb: SupabaseClient, q: string): Promise<string | null> {
  const text = q.replace(/[(),]/g, " ").trim();
  if (!text) return null;
  const like = `%${text}%`;
  const ors = [`title.ilike.${like}`, `body.ilike.${like}`];
  const [{ data: horses }, { data: trainers }] = await Promise.all([
    sb
      .from("horse")
      .select("id")
      .or(`display_name.ilike.${like},racing_name.ilike.${like},stable_name.ilike.${like}`),
    sb.from("trainer").select("id").or(`name.ilike.${like},display_name.ilike.${like}`),
  ]);
  const horseIds = ((horses ?? []) as { id: string }[]).map((h) => h.id);
  const trainerIds = ((trainers ?? []) as { id: string }[]).map((t) => t.id);
  if (horseIds.length) ors.push(`horse_id.in.(${horseIds.join(",")})`);
  if (trainerIds.length) ors.push(`source_trainer_id.in.(${trainerIds.join(",")})`);
  return ors.join(",");
}

export default async function PostsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { sb } = await requireAdminPage();
  const sp = await searchParams;

  const status: StatusFilter = parseStatusFilter(sp.status);
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const horseId = typeof sp.horseId === "string" ? sp.horseId : "";
  const offset = Math.max(0, parseInt(typeof sp.offset === "string" ? sp.offset : "0", 10) || 0);

  const orClause = await qOrClause(sb, q);

  // Page of rows for the active status filter, with an exact total (M for the
  // "Showing N of M" footer).
  let pageQuery = sb
    .from("post")
    .select(POST_FIELDS, { count: "exact" })
    .order("created_at", { ascending: false });
  if (status !== "all") pageQuery = pageQuery.eq("status", status);
  if (horseId) pageQuery = pageQuery.eq("horse_id", horseId);
  if (orClause) pageQuery = pageQuery.or(orClause);
  const { data, count } = await pageQuery.range(offset, offset + PAGE_SIZE - 1);
  // Untyped RLS client → the select string isn't schema-checked; cast the raw
  // rows to the shape T5's contract guarantees.
  const rows = (data ?? []) as unknown as PostRow[];
  const total = count ?? rows.length;

  // Chip counts: a status tally within the same horse/search scope (but
  // status-agnostic), so each chip shows how many posts it would reveal.
  let countQuery = sb.from("post").select("status");
  if (horseId) countQuery = countQuery.eq("horse_id", horseId);
  if (orClause) countQuery = countQuery.or(orClause);
  const { data: statusRows } = await countQuery;
  const counts = ((statusRows ?? []) as { status: string }[]).reduce<StatusCounts>(
    (acc, r) => {
      acc.all += 1;
      if (r.status === "published" || r.status === "scheduled" || r.status === "draft" || r.status === "unpublished")
        acc[r.status] += 1;
      return acc;
    },
    { all: 0, published: 0, scheduled: 0, draft: 0, unpublished: 0 },
  );

  // Private bucket: sign horse thumbnails (stored as object paths) for display.
  const items = rows.map(mapPostRow);
  const thumbs = await signPhotoMap(sb, HORSE_PHOTO_BUCKET, items.map((p) => p.thumbUrl));
  const posts = items.map((p) => ({
    ...p,
    thumbUrl: p.thumbUrl ? thumbs.get(p.thumbUrl) ?? null : null,
  }));

  return (
    <PostsLibrary
      posts={posts}
      status={status}
      counts={counts}
      q={q}
      horseId={horseId}
      total={total}
      offset={offset}
      limit={PAGE_SIZE}
      hasMore={offset + rows.length < total}
    />
  );
}
