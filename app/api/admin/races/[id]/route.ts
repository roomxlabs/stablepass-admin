import { requireAdmin } from "@/lib/auth/admin";
import { ok, noContent, fail } from "@/lib/api/envelope";

// Correct / remove a race (RF6 / ENG-180). Works on BOTH `manual` and `api` rows.
//
// The load-bearing rule: correcting an `api` row sets race.manual_override=true so
// the RF3 poll stops overwriting it and the human correction sticks. That flag is
// set by this route, never by the client — a caller cannot clear it by sending
// manualOverride:false, because it isn't in FIELD_MAP.

// camelCase request field → race column. Deliberately excludes `source`,
// `manual_override` and `finished_at` (server-owned), and there is no odds /
// betting field anywhere (guardrail §6).
const FIELD_MAP: Record<string, string> = {
  venue: "venue",
  raceDate: "race_date",
  raceNumber: "race_number",
  raceClass: "race_class",
  distanceM: "distance_m",
  scheduledAt: "scheduled_at",
  status: "status",
};

// PATCH /api/admin/races/:id — correct any field on any race.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;
  const { id } = await params;
  const b = await req.json().catch(() => ({}));

  const patch: Record<string, unknown> = {};
  for (const [field, column] of Object.entries(FIELD_MAP)) if (field in b) patch[column] = b[field];
  if (Object.keys(patch).length === 0)
    return fail("validation_failed", "No editable fields provided.", 400);

  // NB: `!= null` would let an explicit `{status: null}` slip past into a NOT NULL
  // column. Validate whenever the key was sent at all.
  if ("status" in patch && !["upcoming", "finished"].includes(String(patch.status)))
    return fail("validation_failed", "status must be 'upcoming' or 'finished'.", 400);

  // Same NaN-defeats-the-natural-key hazard as the create route.
  if ("race_number" in patch && patch.race_number !== null) {
    const n = Number(patch.race_number);
    if (!Number.isInteger(n) || n < 1)
      return fail("validation_failed", "raceNumber must be a positive integer.", 400);
    patch.race_number = n;
  }
  if ("distance_m" in patch && patch.distance_m !== null) {
    const d = Number(patch.distance_m);
    if (!Number.isInteger(d) || d < 0)
      return fail("validation_failed", "distanceM must be a non-negative integer.", 400);
    patch.distance_m = d;
  }

  const { data: race } = await sb.from("race").select("source").eq("id", id).maybeSingle();
  if (!race) return fail("not_found", "Race not found.", 404);

  // Correcting a feed row pins it: the poll must not undo this edit.
  if (race.source === "api") patch.manual_override = true;

  const { data, error } = await sb
    .from("race")
    .update(patch)
    .eq("id", id)
    .select("id, venue, race_date, race_number, race_class, distance_m, scheduled_at, status, source, manual_override")
    .maybeSingle();

  if (error) {
    if (error.code === "23505")
      return fail(
        "race_exists",
        "Another race already exists for that venue, date and race number.",
        409,
      );
    return fail("update_failed", error.message, 400);
  }
  if (!data) return fail("not_found", "Race not found.", 404);
  return ok(data);
}

// DELETE /api/admin/races/:id — remove the race; runners cascade (FK on delete cascade).
// Note for the operator (surfaced in UI copy): deleting an `api` race that was never
// corrected means the next poll may simply re-create it.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;
  const { id } = await params;

  const { data: race } = await sb.from("race").select("id").eq("id", id).maybeSingle();
  if (!race) return fail("not_found", "Race not found.", 404);

  const { error } = await sb.from("race").delete().eq("id", id);
  if (error) return fail("delete_failed", error.message, 400);
  return noContent();
}
