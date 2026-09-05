import { requireAdmin } from "@/lib/auth/admin";
import { ok } from "@/lib/api/envelope";
import { listWaitlist, WAITLIST_PAGE_SIZE } from "@/app/(dash)/waitlist/data";

// GET /api/admin/waitlist?q=&offset=&limit= — the admin Waitlist list.
//
// READ PATH: uses `requireAdmin()`'s `sb`, i.e. the CALLER's own RLS client —
// never a service-role client. `public.waitlist` has an admin-only RLS policy
// (`waitlist_select_admin`, is_admin + AAL2); that policy, not this route, is
// what keeps the addresses private, and requireAdmin() has already gated on
// both is_admin and AAL2 before `sb` is handed back. (The ticket's "reads must
// go through the service client" is stale — see `.rx/gotchas.md`: "Never use
// a service-role client here.")
export async function GET(req: Request) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const u = new URL(req.url);
  const q = u.searchParams.get("q")?.trim() || undefined;
  const offset = Math.floor(Math.max(Number(u.searchParams.get("offset")) || 0, 0));
  const limitParam = Number(u.searchParams.get("limit"));
  // Floor it: a fractional ?limit=2.5 would become a fractional range window.
  const limit = Math.floor(Math.min(Math.max(limitParam || WAITLIST_PAGE_SIZE, 1), 200));

  const { rows, total, matching } = await listWaitlist(sb, { q, offset, limit });
  const res = ok(rows, { total, matching, offset, limit });
  // These rows are member email addresses. The export sibling already refuses
  // to be cached; say the same here rather than leaving the two asymmetric.
  res.headers.set("cache-control", "no-store");
  return res;
}
