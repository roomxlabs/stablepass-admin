import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth/admin";
import { getPostAnalytics } from "@/lib/analytics/queries";
import PostAnalytics from "./PostAnalytics";
import "../../analytics.css";

// Per-post analytics — 10-post-analytics.html. Re-asserts requireAdminPage()
// rather than leaning on the (dash) layout gate (see .rx/gotchas.md).
export const dynamic = "force-dynamic";

export default async function PostAnalyticsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { sb } = await requireAdminPage();
  const { id } = await params;

  const data = await getPostAnalytics(sb, id);
  if (!data) notFound();

  return <PostAnalytics data={data} />;
}
