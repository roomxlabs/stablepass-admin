import { requireAdmin } from "@/lib/auth/admin";
import { created, fail } from "@/lib/api/envelope";
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin(); if ("res" in g) return g.res; const { sb } = g;
  const { id } = await params; const b = await req.json();
  const { data, error } = await sb.from("trainer_contact").insert({ trainer_id:id, role:b.role, name:b.name, email:b.email ?? null, phone:b.phone ?? null }).select("*").single();
  if (error) return fail("insert_failed", error.message, 400); return created(data);
}
