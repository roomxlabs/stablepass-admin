import { requireAdmin } from "@/lib/auth/admin";
import { ok, created, fail } from "@/lib/api/envelope";

// Runners on a race (RF6 / ENG-180). A manually attached runner is indistinguishable
// downstream from a feed-attached one: it lands as a `race_horse` row with
// entry_status='confirmed', so the 2h race-day-sweep reminder and the pushes fire
// exactly the same way they do for `api` rows.
//
// No odds / betting fields, and no owner PII — only the horse, its barrier and jockey.

// GET /api/admin/races/:id/runners — the runners on this race.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;
  const { id } = await params;

  const { data, error } = await sb
    .from("race_horse")
    .select(
      "id, race_id, horse_id, barrier, jockey, result, finish_position, entry_status, horse:horse_id(display_name, racing_name)",
    )
    .eq("race_id", id);

  if (error) return fail("read_failed", error.message, 400);
  return ok(data ?? []);
}

// POST /api/admin/races/:id/runners — attach a horse to the race.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;
  const { id } = await params;
  const b = await req.json().catch(() => ({}));

  if (!b?.horseId) return fail("validation_failed", "horseId is required.", 400);

  const hasBarrier = b.barrier != null && b.barrier !== "";
  const barrier = hasBarrier ? Number(b.barrier) : null;
  if (barrier != null && (!Number.isInteger(barrier) || barrier < 1))
    return fail("validation_failed", "barrier must be a positive integer.", 400);

  const { data: race, error: raceErr } = await sb
    .from("race")
    .select("id, source")
    .eq("id", id)
    .maybeSingle();
  // Don't let a failed read masquerade as a missing race.
  if (raceErr) return fail("read_failed", raceErr.message, 400);
  if (!race) return fail("not_found", "Race not found.", 404);

  const { data, error } = await sb
    .from("race_horse")
    .insert({
      race_id: id,
      horse_id: b.horseId,
      barrier,
      jockey: b.jockey ?? null,
      entry_status: "confirmed",
    })
    .select("id, race_id, horse_id, barrier, jockey, entry_status")
    .single();

  if (error) {
    // race_horse_unique (race_id, horse_id): a horse runs once per race.
    if (error.code === "23505")
      return fail("runner_exists", "That horse is already entered in this race.", 409);
    return fail("insert_failed", error.message, 400);
  }

  // Attaching a runner by hand to an `api` race is a correction to feed-owned data, so
  // pin it for the same reason the result path does: an unpinned race gets its runner set
  // rewritten by the next poll, silently dropping this entry.
  //
  // The runner already exists, so a failed pin must not turn a 201 into an error — but it
  // must not vanish either. Surface it in the response so the caller knows the entry is
  // at risk rather than being told everything is fine.
  let pinned: boolean | undefined;
  if (race.source === "api") {
    const { error: pinErr } = await sb
      .from("race")
      .update({ manual_override: true })
      .eq("id", id);
    pinned = !pinErr;
    if (pinErr) console.error("[racing-manual] failed to pin api race %s: %s", id, pinErr.message);
  }

  return created(pinned === false ? { ...data, pinned: false } : data);
}
