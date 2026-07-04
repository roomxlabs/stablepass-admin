import { requireAdmin } from "@/lib/auth/admin";
import { created, fail } from "@/lib/api/envelope";
export async function POST(req: Request) {
  const g = await requireAdmin(); if ("res" in g) return g.res; const { sb } = g;
  const b = await req.json();
  if (!b.trainerId) return fail("validation_failed", "trainerId required", 400);
  const display = b.displayName ?? ([b.sire, b.dam].filter(Boolean).join(" x ") || "Unnamed");
  const { data, error } = await sb.from("horse").insert({
    trainer_id: b.trainerId, sire: b.sire ?? null, dam: b.dam ?? null, display_name: display,
    sex: b.sex ?? null, colour: b.colour ?? null, foaling_year: b.foalingYear ?? null, stable_name: b.stableName ?? null,
  }).select("id,display_name").single();
  if (error) return fail("insert_failed", error.message, 400);
  return created(data);
}
