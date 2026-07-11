import { requireAdmin } from "@/lib/auth/admin";
import { ok } from "@/lib/api/envelope";
import { getAnalytics } from "@/lib/dashboard/queries";

// GET /api/admin/analytics — dashboard tiles + quiet horses.
// Tiles: posts published this week, reactions & saves created this week,
// members (subscriptions in trial|active). Quiet horses: active horses with no
// published post in the last 7 days. Aggregates only — no owner PII.
export async function GET() {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const analytics = await getAnalytics(sb);
  return ok(analytics);
}
