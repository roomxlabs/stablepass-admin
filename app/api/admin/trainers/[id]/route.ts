import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin(); if ("res" in g) return g.res; const { sb } = g;
  const { id } = await params; const b = await req.json();
  const map: Record<string,string> = { name:"name", stableName:"stable_name", location:"location", bio:"bio", photoUrl:"photo_url", status:"status" };
  const patch: Record<string, unknown> = {}; for (const k in map) if (k in b) patch[map[k]] = b[k];
  const { data, error } = await sb.from("trainer").update(patch).eq("id", id).select("*").single();
  if (error) return fail("update_failed", error.message, 400); return ok(data);
}
