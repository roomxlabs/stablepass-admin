import { requireAdmin } from "@/lib/auth/admin";
import { created, fail } from "@/lib/api/envelope";

// POST /api/admin/trainers — create a trainer (content source, not a user).
// Admin-only (requireAdmin → 403). `slug` is unique; a collision returns 409
// rather than a raw DB error so the add-trainer form can prompt for a new name.
export async function POST(req: Request) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const b = await req.json().catch(() => ({}));
  if (!b?.name || !b?.slug)
    return fail("validation_failed", "name and slug are required.", 400);
  if (b.status && !["active", "onboarding"].includes(b.status))
    return fail("validation_failed", "status must be 'active' or 'onboarding'.", 400);
  if (b.marketingVisible !== undefined && typeof b.marketingVisible !== "boolean")
    return fail("validation_failed", "marketingVisible must be a boolean.", 400);

  // marketing_visible defaults to false so a trainer is never published to
  // the public marketing site by accident.
  const { data, error } = await sb
    .from("trainer")
    .insert({
      name: b.name,
      display_name: b.displayName ?? b.name,
      slug: b.slug,
      stable_name: b.stableName ?? null,
      location: b.location ?? null,
      bio: b.bio ?? null,
      photo_url: b.photoUrl ?? null,
      status: b.status ?? "active",
      marketing_visible: b.marketingVisible === true,
    })
    .select("id,name,display_name,slug,status,marketing_visible")
    .single();

  if (error) {
    if (error.code === "23505")
      return fail("slug_taken", "A trainer with that slug already exists.", 409);
    return fail("insert_failed", error.message, 400);
  }
  return created(data);
}
