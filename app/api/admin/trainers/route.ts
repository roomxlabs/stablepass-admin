import { requireAdmin } from "@/lib/auth/admin";
import { created, fail } from "@/lib/api/envelope";
export async function POST(req: Request) {
  const g = await requireAdmin(); if ("res" in g) return g.res; const { sb } = g;
  const b = await req.json();
  if (!b.name || !b.slug) return fail("validation_failed", "name, slug required", 400);
  const { data, error } = await sb.from("trainer").insert({
    name:b.name, display_name:b.displayName ?? b.name, slug:b.slug, stable_name:b.stableName ?? null,
    location:b.location ?? null, bio:b.bio ?? null, photo_url:b.photoUrl ?? null, status:b.status ?? "active",
  }).select("id,slug").single();
  if (error) return fail("insert_failed", error.message, 409); return created(data);
}
