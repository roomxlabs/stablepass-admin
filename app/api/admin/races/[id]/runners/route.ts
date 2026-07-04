import { requireAdmin } from "@/lib/auth/admin";
import { created, fail } from "@/lib/api/envelope";
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin(); if ("res" in g) return g.res; const { sb } = g;
  const { id } = await params; const b = await req.json();
  if (!b.horseId) return fail("validation_failed", "horseId required", 400);
  const { data, error } = await sb.from("race_horse").insert({
    race_id: id, horse_id: b.horseId, barrier: b.barrier ?? null, jockey: b.jockey ?? null,
  }).select("*").single();
  if (error) return fail("insert_failed", error.message, 409);
  return created(data);
}
