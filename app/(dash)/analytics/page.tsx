import { requireAdminPage } from "@/lib/auth/admin";
import { parsePeriod } from "@/lib/analytics/queries";
import AnalyticsScreen from "./AnalyticsScreen";
import { getAnalyticsView } from "./data";
import "./analytics.css";

// Analytics — 09-analytics.html. Period is a URL search param (?period=7d|30d|all,
// default 30d) so the toggle is plain links and this server component refetches.
//
// Re-asserts requireAdminPage(): the (dash) layout gate is rendered in PARALLEL
// with the page and cached across soft navigations, so it does not gate this
// page's own reads (see .rx/gotchas.md).
export const dynamic = "force-dynamic";

type Search = { period?: string };

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const { sb } = await requireAdminPage();
  const sp = await searchParams;

  // An invalid ?period= falls back to the default rather than erroring — the
  // toggle only ever emits valid values, so this is a hand-typed URL.
  const period = parsePeriod(sp.period ?? null) ?? "30d";
  const view = await getAnalyticsView(sb, period);

  return <AnalyticsScreen view={view} />;
}
