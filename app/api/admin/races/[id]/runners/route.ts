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

  // Pin BEFORE inserting the runner, mirroring the result path's ordering.
  //
  // Attaching a runner by hand to an `api` race is a correction to feed-owned data; left
  // unpinned, the next RF3 poll rewrites the runner set and silently drops this entry.
  // Pinning afterwards meant a failed pin could only be reported in the response body —
  // and the sole caller (RaceDetail's `call()`) discards the body on 201, so the operator
  // was told everything was fine while the entry was at risk. Pinning first turns that
  // into a 409 with NOTHING mutated, which is retryable and actually visible.
  //
  // The `.select()` is what makes the failure detectable at all: a filtered UPDATE
  // matches zero rows and returns no error, so `!pinErr` alone would report success.
  //
  // Cost of the reorder, stated plainly: a race pinned by a request whose insert then
  // 23505s stays pinned with no runner attached, and NOTHING in this repo writes
  // manual_override back to false — undoing it needs direct DB access. RaceDetail filters
  // out already-attached horses, so a fresh page cannot hit it; a stale page or a
  // concurrent RF3 insert can, and the operator sees "already entered" while the race has
  // been frozen. Accepted because the other ordering's failure is worse: an unpinned api
  // race silently double-counts career stats forever.
  //
  // ⚠ `.select("id")` below is load-bearing, NOT dead code. Without it supabase-js returns
  // {data: null} even on a successful update, so `pinnedRow` is always null and every api
  // attach 409s — a total outage. The fake does not model `Prefer: return=representation`,
  // so no test catches its removal (see ENG-321). Do not "simplify" it away.
  if (race.source === "api") {
    const { data: pinnedRow, error: pinErr } = await sb
      .from("race")
      .update({ manual_override: true })
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (pinErr) return fail("update_failed", pinErr.message, 400);
    if (!pinnedRow)
      return fail(
        "pin_failed",
        "Could not pin the race; refusing to attach a runner the next poll would drop.",
        409,
      );
  }

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

  return created(data);
}
