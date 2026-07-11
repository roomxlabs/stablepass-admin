import { requireAdmin } from "@/lib/auth/admin";
import { created, fail } from "@/lib/api/envelope";

// POST /api/admin/horses — create a horse (screens/07-add-horse.html).
// Guardrails: requireAdmin (403 non-admin); NO owner field ever; age is never
// stored (only foaling_year). display_name is derived when the horse is unnamed.
const TRAINING_STATUSES = ["spelling", "pre_training", "farm_training", "city_training", "racing", "retired"];
const HORSE_STATUSES = ["active", "disabled"];

export async function POST(req: Request) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const b = await req.json().catch(() => ({}));
  if (!b.trainerId) return fail("validation_failed", "trainerId required", 400, { trainerId: "required" });

  const displayName =
    b.displayName ??
    b.stableName ??
    b.racingName ??
    ([b.sire, b.dam].filter(Boolean).join(" × ") || "Unnamed");

  const insert: Record<string, unknown> = {
    trainer_id: b.trainerId,
    sire: b.sire ?? null,
    dam: b.dam ?? null,
    display_name: displayName,
    stable_name: b.stableName ?? null,
    racing_name: b.racingName ?? null,
    sex: b.sex ?? null,
    colour: b.colour ?? null,
    foaling_year: b.foalingYear ?? null,
    story: b.story ?? null,
    photo_url: b.photoUrl ?? null,
  };
  if (typeof b.status === "string" && HORSE_STATUSES.includes(b.status)) insert.status = b.status;
  if (typeof b.trainingStatus === "string" && TRAINING_STATUSES.includes(b.trainingStatus)) {
    insert.training_status = b.trainingStatus;
  }
  if (b.starts != null) insert.starts = Number(b.starts) || 0;
  if (b.wins != null) insert.wins = Number(b.wins) || 0;
  if (b.places != null) insert.places = Number(b.places) || 0;
  if (b.prizeMoneyCents != null) insert.prize_money_cents = Number(b.prizeMoneyCents) || 0;

  const { data, error } = await sb.from("horse").insert(insert).select("*").single();
  if (error) return fail("insert_failed", error.message, 400);
  return created(data);
}
