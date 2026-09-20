import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";

/** Columns this route needs. Kept local rather than importing `LABEL_FIELDS` from
 * `../route.ts` (that constant omits `retired_at`, which this handler needs to
 * check) — a second small literal here is cheaper than reshaping the sibling
 * route's exported shape for one caller. */
const LABEL_FIELDS = "id,name,is_builtin,sort_order,retired_at";

type LabelRow = { id: string; name: string; is_builtin: boolean; sort_order: number; retired_at: string | null };

/**
 * DELETE /api/admin/post-labels/:id — retire a label.
 *
 * Guardrail 2: retire, never a SQL delete — the same shape as
 * `post-bylines/:id`. A builtin label can NEVER be retired: it is checked
 * BEFORE any write here, and be's `post_label_pin_builtin` trigger (23514) is
 * a second, defence-in-depth refusal in case the row's `is_builtin` flipped
 * between our read and our write.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;
  const { id } = await params;

  const { data: row, error: readError } = await sb
    .from("post_label")
    .select(LABEL_FIELDS)
    .eq("id", id)
    .maybeSingle();
  if (readError) {
    console.error("post_label query_failed", readError.code);
    return fail("query_failed", "Could not load the label.", 400);
  }
  if (!row) return fail("not_found", "That label does not exist.", 404);

  const label = row as LabelRow;
  if (label.is_builtin)
    return fail("builtin_label", "Built-in labels are permanent and cannot be retired.", 409);

  // Idempotent: an already-retired row is left untouched, no mutation issued.
  if (label.retired_at != null) return ok({ id, retired: true });

  const { error: updateError } = await sb
    .from("post_label")
    .update({ retired_at: new Date().toISOString() })
    .eq("id", id)
    .select(LABEL_FIELDS)
    .single();
  if (updateError) {
    // The DB trigger refused it — the row's is_builtin flipped under us
    // between the read above and this write. Same 409 as the up-front check.
    if (updateError.code === "23514")
      return fail("builtin_label", "Built-in labels are permanent and cannot be retired.", 409);
    console.error("post_label update_failed", updateError.code);
    return fail("update_failed", "Could not retire the label.", 400);
  }

  return ok({ id, retired: true });
}
