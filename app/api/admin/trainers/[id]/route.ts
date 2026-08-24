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
  marketingVisible: "marketing_visible",
  marketingPhotoPath: "marketing_photo_path",
};

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const { id } = await params;
  const b = await req.json().catch(() => ({}));

  if (b?.status && !["active", "onboarding"].includes(b.status))
    return fail("validation_failed", "status must be 'active' or 'onboarding'.", 400);
  if (b?.marketingVisible !== undefined && typeof b.marketingVisible !== "boolean")
    return fail("validation_failed", "marketingVisible must be a boolean.", 400);

  // Mirrors the DB CHECK on trainer.marketing_photo_path: the value is written
  // straight into a PUBLIC object URL, so refuse an absolute path or any
  // parent-directory segment here rather than letting the DB 400 late.
  if ("marketingPhotoPath" in (b ?? {}) && b.marketingPhotoPath !== null) {
    if (typeof b.marketingPhotoPath !== "string" || /^\/|\.\./.test(b.marketingPhotoPath))
      return fail("validation_failed", "marketingPhotoPath must be a relative object path.", 400);
  }

  const patch: Record<string, unknown> = {};
  for (const key in FIELD_MAP) if (key in (b ?? {})) patch[FIELD_MAP[key]] = b[key];
  if (Object.keys(patch).length === 0)
    return fail("validation_failed", "No updatable fields provided.", 400);

  const { data, error } = await sb
    .from("trainer")
    .update(patch)
    .eq("id", id)
    .select("id,name,display_name,slug,stable_name,location,bio,photo_url,status,marketing_visible,marketing_photo_path")
    .single();

  if (error) {
    if (error.code === "PGRST116") return fail("not_found", "Trainer not found.", 404);
    return fail("update_failed", error.message, 400);
  }
  return ok(data);
}
