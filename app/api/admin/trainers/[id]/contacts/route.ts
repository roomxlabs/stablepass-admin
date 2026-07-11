import { requireAdmin } from "@/lib/auth/admin";
import { created, fail } from "@/lib/api/envelope";

// POST /api/admin/trainers/:id/contacts — add an internal contact (the trainer
// or key staff) to a trainer. trainer_contact is ADMIN-ONLY internal PII
// (guardrail §3): it is created and read here, never on a member surface.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const { id } = await params;
  const b = await req.json().catch(() => ({}));
  if (!b?.role || !b?.name)
    return fail("validation_failed", "role and name are required.", 400);

  const { data, error } = await sb
    .from("trainer_contact")
    .insert({
      trainer_id: id,
      role: b.role,
      name: b.name,
      email: b.email ?? null,
      phone: b.phone ?? null,
    })
    .select("id,trainer_id,role,name,email,phone")
    .single();

  if (error) return fail("insert_failed", error.message, 400);
  return created(data);
}
