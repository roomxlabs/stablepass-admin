import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";
import { parsePeriod, periodSince, getClicks } from "@/lib/analytics/queries";

// GET /api/admin/analytics/clicks?period=7d|30d|all — website clicks by trainer.
// Aggregates only — never a user-level field (guardrail: no owner PII).
export async function GET(req: Request) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const period = parsePeriod(new URL(req.url).searchParams.get("period"));
  if (!period) return fail("invalid_period", "period must be one of 7d, 30d, all.", 400);
  const since = periodSince(period);

  try {
    return ok(await getClicks(sb, since));
  } catch (e) {
    console.error("GET /api/admin/analytics/clicks", e);
    return fail("query_failed", "Could not load analytics.", 500);
  }
}
