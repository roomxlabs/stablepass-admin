import { requireAdmin } from "@/lib/auth/admin";
import { fetchAllSubscribers, applyFilters, toCsv } from "@/app/(dash)/subscribers/data";

// GET /api/admin/subscribers/export?status=&minMonths=&maxMonths=&q= — CSV of
// the (optionally filtered) subscriber list.
//
// READ PATH: uses `requireAdmin()`'s `sb` (the caller's own RLS client), same
// as GET /api/admin/subscribers — see that route's comment.
//
// Reads the SAME filter params as the list mode (`status`, `minMonths`,
// `maxMonths`, `q`) but deliberately IGNORES `offset`/`limit`: the export
// covers the whole FILTERED set, every page, not whichever page the admin
// happened to be viewing when they clicked "export".
export async function GET(req: Request) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const url = new URL(req.url);
  const minMonthsRaw = url.searchParams.get("minMonths");
  const maxMonthsRaw = url.searchParams.get("maxMonths");
  const filters = {
    status: url.searchParams.get("status") ?? undefined,
    minMonths: minMonthsRaw != null ? parseInt(minMonthsRaw, 10) : undefined,
    maxMonths: maxMonthsRaw != null ? parseInt(maxMonthsRaw, 10) : undefined,
    q: url.searchParams.get("q") ?? undefined,
  };

  const all = await fetchAllSubscribers(sb);
  const rows = applyFilters(all, filters);

  const date = new Date().toISOString().slice(0, 10);
  return new Response(toCsv(rows), {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="subscribers-${date}.csv"`,
      "cache-control": "no-store",
    },
  });
}
