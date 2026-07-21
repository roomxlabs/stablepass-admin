import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";

// Record a runner's result (RF6 / ENG-180) — the manual counterpart to the RF3
// poll's result ingest, and the one write in this surface with side effects:
//
//   1. the runner  -> result text + finish_position, entry_status='ran'
//   2. the race    -> status='finished' + finished_at
//   3. the horse   -> career counters (starts / wins / places / prize) incremented
//   4. fan-out     -> be push-dispatch `race_result`
//
// Counters must move EXACTLY ONCE per runner. The guard is entry_status, applied as
// a compare-and-swap rather than a read-then-write: the UPDATE itself is scoped to
// the statuses that may still be resulted, so two concurrent submits cannot both pass
// it — the loser matches no row and gets the 409. A plain read-then-write left a
// TOCTOU window wide enough for a double-clicked button to inflate a horse's record.
//
// The scope is an ALLOWLIST ('confirmed','nominated'), not "anything but 'ran'": a
// scratched or not-accepted runner never left the barrier, so it must not earn a
// career start.
//
// Guardrail: no odds / betting fields. `prizeCents` is prize money earned, an integer
// count of cents on the horse's career total — not a wager, price or bookmaker value.

// entry_status values a result may still be recorded against. 'scratched' and
// 'not_accepted' are deliberately excluded — those horses never ran.
const RESULTABLE = ["confirmed", "nominated"];

type ResultBody = {
  result?: string;
  finishPosition?: number | string | null;
  prizeCents?: number | string | null;
};

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;
  const { id } = await params;
  const b: ResultBody = await req.json().catch(() => ({}));

  if (!b?.result && b?.finishPosition == null)
    return fail("validation_failed", "result or finishPosition is required.", 400);

  const finishPosition =
    b.finishPosition != null && b.finishPosition !== "" ? Number(b.finishPosition) : null;
  if (finishPosition != null && (!Number.isInteger(finishPosition) || finishPosition < 1))
    return fail("validation_failed", "finishPosition must be a positive integer.", 400);

  const prizeCents = b.prizeCents != null && b.prizeCents !== "" ? Number(b.prizeCents) : 0;
  if (!Number.isInteger(prizeCents) || prizeCents < 0)
    return fail("validation_failed", "prizeCents must be a non-negative integer.", 400);

  const { data: runner, error: runnerReadErr } = await sb
    .from("race_horse")
    .select("id, race_id, horse_id, entry_status")
    .eq("id", id)
    .maybeSingle();
  // Distinguish "the read failed" from "no such row": swallowing the error would turn
  // an RLS regression into a misleading 404 (see .rx/gotchas.md).
  if (runnerReadErr) return fail("read_failed", runnerReadErr.message, 400);
  if (!runner) return fail("not_found", "Runner not found.", 404);

  if (runner.entry_status === "ran")
    return fail("result_already_recorded", "This runner's result is already recorded.", 409);
  if (!RESULTABLE.includes(String(runner.entry_status)))
    return fail(
      "runner_did_not_run",
      "Only a confirmed or nominated runner can be given a result.",
      409,
    );

  // Pin an `api` race BEFORE anything else is written.
  //
  // A result recorded by hand is a correction to whatever the feed would say, so the
  // race must stop being feed-owned — otherwise the next RF3 poll re-opens it, re-ingests
  // the official result, and increments the career counters below a SECOND time. Counters
  // are never decremented, so the horse's record is corrupted permanently.
  //
  // Two ordering constraints, both learned the hard way:
  //   * NOT folded into the status transition below. That update is scoped
  //     `.eq("status","upcoming")`, so on a race already 'finished' it matches zero rows
  //     and the pin is silently dropped — reachable from the UI, because RaceDetail gates
  //     the Record control on entry_status alone, never on race status.
  //   * BEFORE the compare-and-swap, not after. A failure OF THE PIN ITSELF then leaves
  //     nothing mutated and the action is retryable. Note this does NOT make the whole
  //     handler atomic: a failure AFTER the pin (a lost CAS, a transient error) leaves the
  //     race pinned with no correction recorded, and nothing in this repo ever writes
  //     manual_override back to false — RF3 skips it permanently and only direct DB access
  //     can undo it. That is the accepted trade: one frozen race is recoverable by a human,
  //     silent counter corruption is not.
  const { data: raceRow, error: raceReadErr } = await sb
    .from("race")
    .select("source")
    .eq("id", runner.race_id)
    .maybeSingle();
  // Unknown provenance => pin. A read ERROR and a null ROW both mean we cannot tell 'api'
  // from 'manual', and pinning a manual race is the cheap mistake: RF3 skips on
  // `manual_override` regardless of source, so a wrong pin freezes a race visibly and a
  // human can unstick it. An unpinned api race is silent counter corruption.
  //
  // The pin must PROVE it landed. `.update()` alone returns {error: null} when it matches
  // zero rows, and zero rows is what RLS produces here.
  //
  // Two ways this UPDATE matches nothing, neither of which raises:
  //   * the race was deleted between the source read above and this write.
  //     race_horse_race_id_fkey is ON DELETE CASCADE, so the window is narrow — but the
  //     runner row we already read would be gone too, and we would still proceed.
  //   * a future RLS regression. `race` carries TWO permissive policies and they are not
  //     symmetric — race_select_sub (SELECT, has_content_access) and race_all_admin (ALL,
  //     is_admin) — so SELECT visibility is has_content_access OR is_admin while UPDATE
  //     visibility is is_admin ALONE. Not reachable from THIS handler, since requireAdmin()
  //     has already established is_admin; recorded because the asymmetry is real and the
  //     next reader should not have to rediscover it.
  //
  // Either way `.update()` alone returns {error: null} on zero rows, so without the
  // `.select()` the handler sails on to the counters and the push believing it pinned,
  // and the next poll double-counts.
  //
  // ⚠ `.select("id")` below is load-bearing, NOT dead code. Without it supabase-js returns
  // {data: null} even on a successful update, so `pinnedRow` is always null and every
  // api/unknown-provenance result 409s — a total outage. The fake does not model
  // `Prefer: return=representation`, so no test catches its removal (see ENG-321). Do not
  // "simplify" it away.
  if (raceReadErr || !raceRow || raceRow.source === "api") {
    const { data: pinnedRow, error: pinErr } = await sb
      .from("race")
      .update({ manual_override: true })
      .eq("id", runner.race_id)
      .select("id")
      .maybeSingle();
    if (pinErr) return fail("update_failed", pinErr.message, 400);
    // Refuse rather than record a result that the next poll would double-count. Nothing
    // is mutated yet at this point, so the whole action stays retryable.
    if (!pinnedRow)
      return fail(
        "pin_failed",
        "Could not pin the race; refusing to record a result that could be double-counted.",
        409,
      );
  }

  // Compare-and-swap: the status scope on the UPDATE is the real idempotency guard.
  // The check above only exists to return a precise error message.
  const { data: updated, error: runnerErr } = await sb
    .from("race_horse")
    .update({
      result: b.result ?? null,
      finish_position: finishPosition,
      entry_status: "ran",
    })
    .eq("id", id)
    .in("entry_status", RESULTABLE)
    .select("id, race_id, horse_id, result, finish_position, entry_status")
    .maybeSingle();
  if (runnerErr) return fail("update_failed", runnerErr.message, 400);
  // No row matched → a concurrent request won the race and already recorded it.
  if (!updated)
    return fail("result_already_recorded", "This runner's result is already recorded.", 409);

  // The race is over once a result is in. Scope the write to a race that isn't already
  // finished, so a later runner on the same race can't rewrite finished_at. The
  // manual_override pin is deliberately NOT part of this patch — see above.
  const { error: raceErr } = await sb
    .from("race")
    .update({ status: "finished", finished_at: new Date().toISOString() })
    .eq("id", runner.race_id)
    .eq("status", "upcoming");
  if (raceErr) return fail("update_failed", raceErr.message, 400);

  // Career counters — every recorded run is a start, 1st is a win, 2nd or 3rd is a place,
  // prize money accrues in cents. Wins and places are disjoint buckets: the form line reads
  // "starts / wins / places", so a win must not also count as a placing. This matches RF3
  // (be `.rx/specs/2026-07-20-racing-feed-rf3-poll-racing-api-design.md`, "places = 2nd/3rd"),
  // which this route's own spec defers to — the two write the same horse rows.
  const { data: horse, error: horseReadErr } = await sb
    .from("horse")
    .select("starts, wins, places, prize_money_cents")
    .eq("id", runner.horse_id)
    .maybeSingle();
  // The runner is already flipped to 'ran' at this point, so a silently-skipped counter
  // write could never be retried (the guard above would 409 forever). Fail loudly.
  if (horseReadErr) return fail("read_failed", horseReadErr.message, 400);
  if (!horse) return fail("not_found", "The runner's horse no longer exists.", 404);

  const { error: horseErr } = await sb
    .from("horse")
    .update({
      starts: (horse.starts ?? 0) + 1,
      wins: (horse.wins ?? 0) + (finishPosition === 1 ? 1 : 0),
      places: (horse.places ?? 0) + (finishPosition === 2 || finishPosition === 3 ? 1 : 0),
      prize_money_cents: (horse.prize_money_cents ?? 0) + prizeCents,
    })
    .eq("id", runner.horse_id);
  if (horseErr) return fail("update_failed", horseErr.message, 400);

  // Fan-out is best-effort: a notify failure must never roll back the transitions above.
  let notificationsSent = 0;
  try {
    const { data: push } = await sb.functions.invoke("push-dispatch", {
      body: { type: "race_result", raceHorseId: id, raceId: runner.race_id, horseId: runner.horse_id },
    });
    notificationsSent = (push as { notificationsSent?: number } | null)?.notificationsSent ?? 0;
  } catch {
    notificationsSent = 0;
  }

  return ok({ ...updated, notificationsSent });
}

// The scaffold shipped this endpoint as POST; keep that verb working so any existing
// caller doesn't break while the ticket's PATCH contract becomes the documented one.
export const POST = PATCH;
