import { requireAdmin } from "@/lib/auth/admin";
import { created, fail } from "@/lib/api/envelope";
export async function POST(req: Request) {
  const g = await requireAdmin(); if ("res" in g) return g.res; const { sb } = g;
  const b = await req.json();
  if (!b.raceDate) return fail("validation_failed", "raceDate required", 400);
  const { data, error } = await sb.from("race").insert({
    venue: b.venue ?? null, race_date: b.raceDate, race_number: b.raceNumber ?? null,
    race_class: b.raceClass ?? null, distance_m: b.distanceM ?? null, scheduled_at: b.scheduledAt ?? null,
    status: "upcoming", source: "manual",
  }).select("id,status").single();
  if (error) return fail("insert_failed", error.message, 400);
  return created(data);
}
