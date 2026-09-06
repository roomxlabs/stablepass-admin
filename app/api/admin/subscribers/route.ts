import { requireAdmin } from "@/lib/auth/admin";
import { ok } from "@/lib/api/envelope";
import { getSubscribers } from "@/lib/dashboard/queries";

// GET /api/admin/subscribers?status= — member-count drill-in behind the
// Members tile. Returns aggregate counts by subscription status (optionally
// narrowed to one status). Aggregates only — no user_id or member PII
// (guardrail §4). This is the DEFAULT behaviour, unchanged by ENG-982.
//
// ENG-982 deliberately does NOT add a per-row JSON mode here. The Subscribers
// page renders server-side, calling `listSubscribers()` in the data layer
// directly (app/(dash)/subscribers/page.tsx) — the same idiom the waitlist
// screen uses. An HTTP mode returning member name + email would be PII on the
// wire with no consumer, so this route stays aggregate-only. The one HTTP
// surface the feature does add is the CSV export at ./export.
export async function GET(req: Request) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const url = new URL(req.url);

  const status = url.searchParams.get("status");
  const subscribers = await getSubscribers(sb, status);
  return ok(subscribers);
}
