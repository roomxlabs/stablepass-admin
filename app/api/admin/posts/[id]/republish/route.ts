import { requireAdmin } from "@/lib/auth/admin";
import { ok } from "@/lib/api/envelope";
// POST /api/admin/posts/:id/republish
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin(); if ("res" in g) return g.res; const { sb } = g;
  const { id } = await params;
  // TODO(ticket): republish — status transition + side effects (publish/schedule fan out new_post).
  void sb; void req;
  return ok({ id, action: "republish" });
}
