import { requireAdmin } from "@/lib/auth/admin";
import { ok } from "@/lib/api/envelope";
export async function GET(req: Request) {
  const g = await requireAdmin(); if ("res" in g) return g.res; const { sb } = g;
  const status = new URL(req.url).searchParams.get("status");
  let q = sb.from("subscription").select("user_id,status,trial_ends_at,current_period_end");
  if (status) q = q.eq("status", status);
  const { data } = await q; return ok(data ?? [], { nextCursor: null, hasMore: false });
}
