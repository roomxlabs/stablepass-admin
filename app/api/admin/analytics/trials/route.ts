import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";
import { getTrials } from "@/lib/analytics/queries";
import { toCsv, trialsCsvFilename } from "@/lib/analytics/csv";

// GET /api/admin/analytics/trials?format=csv — trial cohort (every subscription
// row starts as a trial; status distinguishes trial/active/lapsed/canceled).
export async function GET(req: Request) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const format = new URL(req.url).searchParams.get("format");
  if (format != null && format !== "csv") return fail("invalid_format", "format must be csv.", 400);

  try {
    const { byMonth, list } = await getTrials(sb);

    if (format === "csv") {
      const csv = toCsv(
        ["name", "email", "trial_start", "trial_end", "status"],
        list.map((r) => [r.name, r.email, r.startedAt, r.endsAt, r.status]),
      );
      return new Response(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${trialsCsvFilename()}"`,
        },
      });
    }

    return ok({ byMonth, list });
  } catch (e) {
    console.error("GET /api/admin/analytics/trials", e);
    return fail("query_failed", "Could not load analytics.", 500);
  }
}
