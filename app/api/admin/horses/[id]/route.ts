import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail, noContent } from "@/lib/api/envelope";
import { blockedMessage, foreignKeyMessage, isForeignKeyViolation } from "@/lib/api/references";
import {
  parseSharesForSale,
  rejectSharesWithoutTrainerWebsite,
  trainerIdForHorse,
} from "@/lib/horses/shares-for-sale";
import { sexColumns } from "../sex";

// PATCH /api/admin/horses/:id — edit horse attributes (training status incl.
// retired, visibility status, racing name, story, photo, …). requireAdmin.
// Never touches an owner field (guardrail: no owner PII).
//
// `sex` and `isGelded` are NOT in this allowlist: they are validated as a pair
// by sexColumns() before being merged in, because gelded-implies-male cannot be
// checked one field at a time.
// ENG-829: sharesForSale maps to shares_for_sale (boolean only — no price/PII).
const MAP: Record<string, string> = {
  trainingStatus: "training_status",
  status: "status",
  stableName: "stable_name",
  displayName: "display_name",
  racingName: "racing_name",
  colour: "colour",
  foalingYear: "foaling_year",
  story: "story",
  photoUrl: "photo_url",
};

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const { id } = await params;
  const b = await req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  for (const k in MAP) if (k in b) patch[MAP[k]] = b[k];

  const sexRes = sexColumns(b);
  if (!sexRes.ok) {
    return fail("validation_failed", sexRes.error.message, 400, {
      [sexRes.error.field]: sexRes.error.message,
    });
  }
  Object.assign(patch, sexRes.columns);

  const sharesRes = parseSharesForSale(b.sharesForSale);
  if (!sharesRes.ok) return fail("validation_failed", sharesRes.message, 400, { sharesForSale: "invalid" });
  if (sharesRes.value !== undefined) {
    // Turning ON requires the horse's trainer to have a website. Turning OFF
    // is always allowed (BE feed effect already shipped in ENG-828).
    if (sharesRes.value === true) {
      const trainer = await trainerIdForHorse(sb, id);
      if (!trainer.ok) return trainer.res;
      const blocked = await rejectSharesWithoutTrainerWebsite(sb, trainer.trainerId);
      if (blocked) return blocked;
    }
    patch.shares_for_sale = sharesRes.value;
  }

  if (Object.keys(patch).length === 0) {
    return fail("validation_failed", "No editable fields provided.", 400);
  }

  const { data, error } = await sb.from("horse").update(patch).eq("id", id).select("*").maybeSingle();
  if (error) {
    // Generic message only — see the note in the create route.
    console.error("[horses] update failed", { code: error.code });
    return fail("update_failed", "Could not update the horse.", 400);
  }
  if (!data) return fail("not_found", "Horse not found.", 404);
  return ok(data);
}

// DELETE /api/admin/horses/:id — remove a horse (operator data cleanup).
//
// REFUSED, NOT CASCADED. `post.horse_id` is `not null references horse(id)`
// with no ON DELETE, so Postgres rejects this outright while any post — of any
// status — still points at the horse. Everything else that references a horse
// (follow, notify_optin, race_horse) cascades.
//
// The count is taken UP FRONT so the refusal can name a number ("Cannot delete:
// 3 posts reference this horse") instead of surfacing a bare 23503, and so the
// screen can disable the button with that same reason before it is ever
// clicked. The 23503 catch below is the backstop for the gap between the count
// and the delete, not the primary path.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;
  const { id } = await params;

  const { count, error: countErr } = await sb
    .from("post")
    .select("id", { count: "exact", head: true })
    .eq("horse_id", id);
  // Refuse rather than guess. A failed count must NOT fall through to the
  // delete: "we could not check" is not "nothing references it".
  if (countErr) return fail("delete_failed", "Could not check what references this horse.", 400);

  const blocked = blockedMessage("horse", [
    { count: count ?? 0, singular: "post", plural: "posts" },
  ]);
  if (blocked) return fail("has_references", blocked, 409);

  // `.select()` on the delete is what makes a missing row a 404: under admin
  // RLS a delete that matches nothing returns neither error nor rows.
  const { data, error } = await sb.from("horse").delete().eq("id", id).select("id").maybeSingle();
  if (isForeignKeyViolation(error)) return fail("has_references", foreignKeyMessage("horse"), 409);
  if (error) {
    console.error("[horses] delete failed", { code: error.code });
    return fail("delete_failed", "Could not delete the horse.", 400);
  }
  if (!data) return fail("not_found", "Horse not found.", 404);
  return noContent();
}
