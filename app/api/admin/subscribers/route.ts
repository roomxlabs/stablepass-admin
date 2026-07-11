import { requireAdmin } from "@/lib/auth/admin";
import { ok } from "@/lib/api/envelope";
import { getSubscribers } from "@/lib/dashboard/queries";

// GET /api/admin/subscribers?status= — member-count drill-in behind the
// Members tile. Returns aggregate counts by subscription status (optionally
// narrowed to one status). Aggregates only — no user_id or member PII
// (guardrail §4).
export async function GET(req: Request) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const status = new URL(req.url).searchParams.get("status");
  const subscribers = await getSubscribers(sb, status);
  return ok(subscribers);
}
