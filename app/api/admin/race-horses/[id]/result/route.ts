import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin(); if ("res" in g) return g.res; const { sb } = g;
  const { id } = await params; const b = await req.json();
  const { data, error } = await sb.from("race_horse").update({ result: b.result, finish_position: b.finishPosition ?? null }).eq("id", id).select("id,result").single();
  if (error) return fail("update_failed", error.message, 400);
  // TODO(ticket): mark race finished when runners done; invoke be push-dispatch race_result.
  return ok({ ...data, notificationsSent: 0 });
}
