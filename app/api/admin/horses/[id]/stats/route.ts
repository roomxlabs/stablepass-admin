import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin(); if ("res" in g) return g.res; const { sb } = g;
  const { id } = await params; const b = await req.json();
  const { data, error } = await sb.from("horse").update({ starts:b.starts, wins:b.wins, places:b.places, prize_money_cents:b.prizeMoneyCents }).eq("id", id).select("id,starts,wins,places,prize_money_cents").single();
  if (error) return fail("update_failed", error.message, 400); return ok(data);
}
