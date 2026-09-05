import { requireAdmin } from "@/lib/auth/admin";
import { ok } from "@/lib/api/envelope";
import { getSubscribers } from "@/lib/dashboard/queries";
import { listSubscribers } from "@/app/(dash)/subscribers/data";

// GET /api/admin/subscribers?status= — member-count drill-in behind the
// Members tile. Returns aggregate counts by subscription status (optionally
// narrowed to one status). Aggregates only — no user_id or member PII
// (guardrail §4). This is the DEFAULT behaviour, unchanged by ENG-982.
//
// GET /api/admin/subscribers?view=list&status=&minMonths=&maxMonths=&q=&offset=&limit=
// — opt-in per-row mode behind the same route (ENG-982), for the admin
// Subscribers page. Returns `{ data: rows, meta: { total, matching, offset,
// limit } }` via the same `ok()` envelope. Any `view` other than "list" (or
// none) falls through to the aggregate path above, byte-for-byte.
export async function GET(req: Request) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const url = new URL(req.url);

  if (url.searchParams.get("view") === "list") {
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "", 10) || 0);
    const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") ?? "", 10) || 25));
    const minMonthsRaw = url.searchParams.get("minMonths");
    const maxMonthsRaw = url.searchParams.get("maxMonths");
    const list = await listSubscribers(sb, {
      status: url.searchParams.get("status") ?? undefined,
      minMonths: minMonthsRaw != null ? parseInt(minMonthsRaw, 10) : undefined,
      maxMonths: maxMonthsRaw != null ? parseInt(maxMonthsRaw, 10) : undefined,
      q: url.searchParams.get("q") ?? undefined,
      offset,
      limit,
    });
    return ok(list.rows, { total: list.total, matching: list.matching, offset: list.offset, limit: list.limit });
  }

  const status = url.searchParams.get("status");
  const subscribers = await getSubscribers(sb, status);
  return ok(subscribers);
}
