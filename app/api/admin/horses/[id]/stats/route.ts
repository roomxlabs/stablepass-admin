import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";

// PATCH /api/admin/horses/:id/stats — manual career stats. requireAdmin.
const FIELDS: [key: string, col: string][] = [
  ["starts", "starts"],
  ["wins", "wins"],
  ["places", "places"],
  ["prizeMoneyCents", "prize_money_cents"],
];

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const { id } = await params;
  const b = await req.json().catch(() => ({}));

  const patch: Record<string, number> = {};
  for (const [key, col] of FIELDS) {
    if (b[key] == null) continue;
    const n = Number(b[key]);
    if (!Number.isFinite(n) || n < 0) {
      return fail("validation_failed", `${key} must be a non-negative number.`, 400, { [key]: "invalid" });
    }
    patch[col] = Math.round(n);
  }
  if (Object.keys(patch).length === 0) {
    return fail("validation_failed", "No stats provided.", 400);
  }

  const { data, error } = await sb
    .from("horse")
    .update(patch)
    .eq("id", id)
    .select("id,starts,wins,places,prize_money_cents")
    .maybeSingle();
  if (error) return fail("update_failed", error.message, 400);
  if (!data) return fail("not_found", "Horse not found.", 404);
  return ok(data);
}
