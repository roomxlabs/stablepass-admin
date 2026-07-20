import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";

// PATCH /api/admin/racing-matches/:id — resolve one match proposal (RF4).
//
//   { action: 'confirm' } -> horse.racing_api_id = proposal.racing_api_id,
//                            proposal status='confirmed', resolved_at=now().
//                            This is the ONE-TIME human gate: once the horse
//                            carries a feed id, the poller (RF3) ingests its
//                            races and they become member-visible without a
//                            further publish step (the locked carve-out).
//   { action: 'reject'  } -> status='rejected', resolved_at=now(). The unique
//                            (horse_id, racing_api_id) pair means the same
//                            candidate is never proposed again.
//
// Admin-only: requireAdmin (401 no session / 403 non-admin) plus the
// admin-only RLS policy on horse_match_proposal (RF1).
const ACTIONS = ["confirm", "reject"] as const;
type Action = (typeof ACTIONS)[number];

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { action?: unknown };
  const action = body.action as Action | undefined;
  if (!action || !ACTIONS.includes(action)) {
    return fail("validation_failed", "action must be 'confirm' or 'reject'.", 400, {
      action: "Expected 'confirm' or 'reject'.",
    });
  }

  const { data: proposal, error: readErr } = await sb
    .from("horse_match_proposal")
    .select("id,horse_id,racing_api_id,status")
    .eq("id", id)
    .maybeSingle();
  if (readErr) return fail("query_failed", "Could not load the proposal.", 500);
  if (!proposal) return fail("not_found", "Match proposal not found.", 404);

  // A resolved proposal stays resolved — re-resolving is a conflict, not a
  // silent no-op, so a stale queue tab can't quietly flip an earlier decision.
  if (proposal.status !== "pending") {
    return fail("invalid_status", `This proposal is already ${proposal.status}.`, 409);
  }

  const resolvedAt = new Date().toISOString();

  if (action === "reject") {
    // Compare-and-swap on status: the read above is a moment old, so a second
    // tab could have resolved this proposal in between. Re-asserting
    // status='pending' in the WHERE makes the transition atomic — zero rows
    // back means someone else won, which is the same 409 as above.
    const { data, error } = await sb
      .from("horse_match_proposal")
      .update({ status: "rejected", resolved_at: resolvedAt })
      .eq("id", id)
      .eq("status", "pending")
      .select("id,status,resolved_at")
      .maybeSingle();
    if (error) return fail("update_failed", "Could not reject the proposal.", 500);
    if (!data) return fail("invalid_status", "This proposal was already resolved.", 409);
    return ok({ id: data.id, status: data.status, resolvedAt: data.resolved_at });
  }

  // --- confirm ------------------------------------------------------------
  const { data: horse, error: horseErr } = await sb
    .from("horse")
    .select("id,racing_api_id")
    .eq("id", proposal.horse_id)
    .maybeSingle();
  if (horseErr) return fail("query_failed", "Could not load the horse.", 500);
  if (!horse) return fail("not_found", "Horse not found.", 404);

  // Already linked to a DIFFERENT feed id: refuse, and write nothing. Silently
  // overwriting would re-point every future race for a horse an operator had
  // already matched.
  if (horse.racing_api_id && horse.racing_api_id !== proposal.racing_api_id) {
    return fail(
      "already_linked",
      "This horse is already linked to a different racing feed id.",
      409,
    );
  }

  // Re-confirming the SAME id is idempotent — skip the redundant write.
  if (!horse.racing_api_id) {
    // Compare-and-swap, NOT a bare update. The check above read the horse a
    // moment ago; two proposals for the same horse confirmed concurrently
    // would both see null and both write, and the last writer would silently
    // re-point the horse at the wrong feed — exactly what the 409 exists to
    // prevent. `.is("racing_api_id", null)` makes the link atomic: zero rows
    // back means someone linked it first, so we report the same conflict.
    // (There is no unique constraint on horse.racing_api_id to backstop this.)
    const { data: linked, error: linkErr } = await sb
      .from("horse")
      .update({ racing_api_id: proposal.racing_api_id })
      .eq("id", proposal.horse_id)
      .is("racing_api_id", null)
      .select("id")
      .maybeSingle();
    if (linkErr) return fail("update_failed", "Could not link the horse to the feed.", 500);
    if (!linked) {
      return fail(
        "already_linked",
        "This horse was linked to a different racing feed id while you were reviewing.",
        409,
      );
    }
  }

  const { data, error } = await sb
    .from("horse_match_proposal")
    .update({ status: "confirmed", resolved_at: resolvedAt })
    .eq("id", id)
    .eq("status", "pending")
    .select("id,status,resolved_at")
    .maybeSingle();
  if (error) return fail("update_failed", "Could not confirm the proposal.", 500);
  if (!data) return fail("invalid_status", "This proposal was already resolved.", 409);

  return ok({
    id: data.id,
    status: data.status,
    resolvedAt: data.resolved_at,
    horseId: proposal.horse_id,
    racingApiId: proposal.racing_api_id,
  });
}
