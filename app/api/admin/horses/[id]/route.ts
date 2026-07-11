import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";

// PATCH /api/admin/horses/:id — edit horse attributes (training status incl.
// retired, visibility status, racing name, story, photo, …). requireAdmin.
// Never touches an owner field (guardrail: no owner PII).
const MAP: Record<string, string> = {
  trainingStatus: "training_status",
  status: "status",
  stableName: "stable_name",
  displayName: "display_name",
  racingName: "racing_name",
  sex: "sex",
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
  if (Object.keys(patch).length === 0) {
    return fail("validation_failed", "No editable fields provided.", 400);
  }

  const { data, error } = await sb.from("horse").update(patch).eq("id", id).select("*").maybeSingle();
  if (error) return fail("update_failed", error.message, 400);
  if (!data) return fail("not_found", "Horse not found.", 404);
  return ok(data);
}
