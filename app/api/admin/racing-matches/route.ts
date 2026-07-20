import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";
import { getPendingProposals } from "@/app/(dash)/racing-matches/data";

// GET /api/admin/racing-matches — the pending horse↔feed match queue (RF4).
// Each row pairs the platform horse with the feed's evidence so an operator
// can eyeball a mismatch before confirming. Admin-only: requireAdmin (401 no
// session / 403 non-admin), and horse_match_proposal's RLS policy is
// admin-only besides. Evidence is allowlist-projected in data.ts — the feed's
// owner field is never stored (RF1) and never rendered (guardrail 4).
export async function GET() {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  try {
    const proposals = await getPendingProposals(sb);
    return ok(proposals, { count: proposals.length });
  } catch {
    // Generic — never surface the Postgres message (leaks schema/SQL).
    return fail("query_failed", "Could not load the match queue.", 500);
  }
}
