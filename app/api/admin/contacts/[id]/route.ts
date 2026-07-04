import { requireAdmin } from "@/lib/auth/admin";
import { ok, noContent, fail } from "@/lib/api/envelope";
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin(); if ("res" in g) return g.res; const { sb } = g;
  const { id } = await params; const b = await req.json();
  const { data, error } = await sb.from("trainer_contact").update({ role:b.role, name:b.name, email:b.email, phone:b.phone }).eq("id", id).select("*").single();
  if (error) return fail("update_failed", error.message, 400); return ok(data);
}
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin(); if ("res" in g) return g.res; const { sb } = g;
  const { id } = await params; await sb.from("trainer_contact").delete().eq("id", id); return noContent();
}
