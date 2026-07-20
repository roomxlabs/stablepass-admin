import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";
import { getPostAnalytics } from "@/lib/analytics/queries";

// GET /api/admin/analytics/posts/:id — opens, reactions, saves, reach for one post.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const { id } = await params;
  try {
    const data = await getPostAnalytics(sb, id);
    if (!data) return fail("not_found", "Post not found.", 404);
    return ok(data);
  } catch (e) {
    console.error("GET /api/admin/analytics/posts/:id", e);
    return fail("query_failed", "Could not load analytics.", 500);
  }
}
