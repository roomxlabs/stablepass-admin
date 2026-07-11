import { requireAdmin } from "@/lib/auth/admin";
import { ok, noContent, fail } from "@/lib/api/envelope";

// PATCH/DELETE /api/admin/contacts/:id — edit or remove a single internal
// trainer contact. Admin-only (guardrail §3: trainer_contact is never
// subscriber-facing). Partial update; DELETE is a hard remove (internal record,
// not published content — the soft-hide rule §2 applies to posts only).
const FIELD_MAP: Record<string, string> = {
  role: "role",
  name: "name",
  email: "email",
  phone: "phone",
};

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const { id } = await params;
  const b = await req.json().catch(() => ({}));

  const patch: Record<string, unknown> = {};
  for (const key in FIELD_MAP) if (key in (b ?? {})) patch[FIELD_MAP[key]] = b[key];
  if (Object.keys(patch).length === 0)
    return fail("validation_failed", "No updatable fields provided.", 400);

  const { data, error } = await sb
    .from("trainer_contact")
    .update(patch)
    .eq("id", id)
    .select("id,trainer_id,role,name,email,phone")
    .single();

  if (error) {
    if (error.code === "PGRST116") return fail("not_found", "Contact not found.", 404);
    return fail("update_failed", error.message, 400);
  }
  return ok(data);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const { id } = await params;
  const { error } = await sb.from("trainer_contact").delete().eq("id", id);
  if (error) return fail("delete_failed", error.message, 400);
  return noContent();
}
