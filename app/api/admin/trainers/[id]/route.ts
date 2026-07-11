import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";

// PATCH /api/admin/trainers/:id — update trainer profile / roster status.
// Admin-only. Only the fields present in the body are written (partial update);
// an id that matches no row returns 404.
const FIELD_MAP: Record<string, string> = {
  name: "name",
  displayName: "display_name",
  stableName: "stable_name",
  location: "location",
  bio: "bio",
  photoUrl: "photo_url",
  status: "status",
};

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const { id } = await params;
  const b = await req.json().catch(() => ({}));

  if (b?.status && !["active", "onboarding"].includes(b.status))
    return fail("validation_failed", "status must be 'active' or 'onboarding'.", 400);

  const patch: Record<string, unknown> = {};
  for (const key in FIELD_MAP) if (key in (b ?? {})) patch[FIELD_MAP[key]] = b[key];
  if (Object.keys(patch).length === 0)
    return fail("validation_failed", "No updatable fields provided.", 400);

  const { data, error } = await sb
    .from("trainer")
    .update(patch)
    .eq("id", id)
    .select("id,name,display_name,slug,stable_name,location,bio,photo_url,status")
    .single();

  if (error) {
    if (error.code === "PGRST116") return fail("not_found", "Trainer not found.", 404);
    return fail("update_failed", error.message, 400);
  }
  return ok(data);
}
