import { requireAdmin } from "@/lib/auth/admin";
import { ok } from "@/lib/api/envelope";
// GET /api/admin/race-day?window=24h — upcoming races + each horse's last-post recency
export async function GET() {
  const g = await requireAdmin(); if ("res" in g) return g.res; const { sb } = g;
  const { data } = await sb.from("race")
    .select("id,venue,race_number,race_class,scheduled_at,race_horse(horse_id,horse(display_name,racing_name,trainer_id))")
    .eq("status", "upcoming").order("scheduled_at", { ascending: true });
  // TODO(ticket): annotate each runner with last-post recency + hasPost flag.
  return ok(data ?? []);
}
