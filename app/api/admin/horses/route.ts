import { requireAdmin } from "@/lib/auth/admin";
import { created, fail } from "@/lib/api/envelope";
import {
  parseSharesForSale,
  rejectSharesWithoutTrainerWebsite,
} from "@/lib/horses/shares-for-sale";
import { sexColumns } from "./sex";

// POST /api/admin/horses — create a horse (screens/07-add-horse.html).
// Guardrails: requireAdmin (403 non-admin); NO owner field ever; age is never
// stored (only foaling_year) and neither is the race-day description — both are
// derived in Postgres. display_name is derived when the horse is unnamed.
// ENG-829: shares_for_sale is a boolean only — no price / owner / vendor fields.
const TRAINING_STATUSES = ["spelling", "pre_training", "farm_training", "city_training", "racing", "retired"];
const HORSE_STATUSES = ["active", "disabled"];

export async function POST(req: Request) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const b = await req.json().catch(() => ({}));
  if (!b.trainerId) return fail("validation_failed", "trainerId required", 400, { trainerId: "required" });

  const sexRes = sexColumns(b);
  if (!sexRes.ok) {
    return fail("validation_failed", sexRes.error.message, 400, {
      [sexRes.error.field]: sexRes.error.message,
    });
  }

  const sharesRes = parseSharesForSale(b.sharesForSale);
  if (!sharesRes.ok) return fail("validation_failed", sharesRes.message, 400, { sharesForSale: "invalid" });
  // True requires the trainer's public website (Shares CTA target). False/absent
  // never needs one — the DB default is false.
  if (sharesRes.value === true) {
    const blocked = await rejectSharesWithoutTrainerWebsite(sb, b.trainerId);
    if (blocked) return blocked;
  }

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
    ...sexRes.columns,
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
  if (sharesRes.value !== undefined) insert.shares_for_sale = sharesRes.value;

  const { data, error } = await sb.from("horse").insert(insert).select("*").single();
  if (error) {
    // Never `error.message`: a Postgres error carries table, column and
    // constraint names (e.g. a 23514 naming `horse_gelded_implies_male`), and
    // the form renders this string straight to the operator. Detail to the
    // server log, a generic message to the caller.
    console.error("[horses] insert failed", { code: error.code });
    return fail("insert_failed", "Could not create the horse.", 400);
  }
  return created(data);
}
