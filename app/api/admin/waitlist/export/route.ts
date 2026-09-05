import { requireAdmin } from "@/lib/auth/admin";
import { fetchAllWaitlist, toCsv } from "@/app/(dash)/waitlist/data";

// GET /api/admin/waitlist/export?q= — CSV of the (optionally filtered)
// waitlist, for pasting a launch invite list into a mail tool.
//
// READ PATH: uses `requireAdmin()`'s `sb` (the caller's own RLS client), same
// as GET /api/admin/waitlist — see that route's comment. `fetchAllWaitlist`
// deliberately IGNORES any `offset`/`limit` on the request: the export exists
// to hand back every matching row, not whichever page the admin was looking
// at when they clicked "export".
export async function GET(req: Request) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const q = new URL(req.url).searchParams.get("q")?.trim() || undefined;
  const rows = await fetchAllWaitlist(sb, { q });

  const date = new Date().toISOString().slice(0, 10);
  return new Response(toCsv(rows), {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="waitlist-${date}.csv"`,
      "cache-control": "no-store",
    },
  });
}
