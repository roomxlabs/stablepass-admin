import { requireAdmin } from "@/lib/auth/admin";
import { ok, created, fail } from "@/lib/api/envelope";

// GET /api/admin/posts?status=&horseId=&q=  — review queue / library + search
export async function GET(req: Request) {
  const g = await requireAdmin(); if ("res" in g) return g.res; const { sb } = g;
  const u = new URL(req.url);
  let q = sb.from("post").select("id,horse_id,type,status,title,like_count,published_at,created_at").order("created_at", { ascending: false });
  const status = u.searchParams.get("status"); if (status) q = q.eq("status", status);
  const horseId = u.searchParams.get("horseId"); if (horseId) q = q.eq("horse_id", horseId);
  const text = u.searchParams.get("q"); if (text) q = q.ilike("title", `%${text}%`); // TODO(ticket): full-text over title/body/horse/trainer
  const { data } = await q;
  return ok(data ?? [], { nextCursor: null, hasMore: false });
}

// POST /api/admin/posts — upload -> Mux(video)/Storage(image·voice) -> draft
export async function POST(req: Request) {
  const g = await requireAdmin(); if ("res" in g) return g.res; const { sb } = g;
  const body = await req.json().catch(() => ({}));
  if (!body.horseId || !body.type || !body.sourceTrainerId) return fail("validation_failed", "horseId, type, sourceTrainerId required", 400);
  // TODO(ticket): push video to Mux / image·voice to Storage, watermark; then insert draft.
  const { data, error } = await sb.from("post").insert({
    horse_id: body.horseId, type: body.type, title: body.title ?? null,
    source_trainer_id: body.sourceTrainerId, status: "draft",
  }).select("id,status,type,horse_id,created_at").single();
  if (error) return fail("insert_failed", error.message, 400);
  return created(data);
}
