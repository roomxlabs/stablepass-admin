import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";
import { getAnalytics } from "@/lib/dashboard/queries";

// GET /api/admin/analytics — dashboard tiles + quiet horses.
// Tiles: posts published this week, reactions & saves created this week,
// members (subscriptions in trial|active). Quiet horses: active horses with no
// published post in the last 7 days. Aggregates only — no owner PII.
export async function GET() {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  // WHY THE try/catch (ENG-984 review, MUST-FIX 1).
  // This route used to be unable to throw: every read in `getAnalytics` was
  // `res.count ?? 0` / `res.data ?? []`, so a failed read degraded to a zero
  // and the route was written against that guarantee. ENG-984 added
  // `await getAdminUserIds(sb)` to `lib/dashboard/queries.ts`, which THROWS by
  // design — a silent empty admin set would put operator activity back into
  // every number, which is the exact bug this ticket exists to remove. That
  // fail-loud choice is right, but it made this route throwable, and without a
  // boundary the rejection escaped `lib/api/envelope.ts` entirely: no
  // `{ok:false, code}` body, and the raw Postgres message (`relation
  // "app_user" does not exist`) went out with it. Schema text is not
  // something an HTTP response gets to carry.
  //
  // The five sibling analytics routes all already have exactly this catch;
  // this one was the hole. The error is logged server-side, where the detail
  // belongs, and the client gets the same generic 500 they do.
  try {
    return ok(await getAnalytics(sb));
  } catch (e) {
    console.error("GET /api/admin/analytics", e);
    return fail("query_failed", "Could not load analytics.", 500);
  }
}
