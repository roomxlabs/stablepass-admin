import { requireAdmin } from "@/lib/auth/admin";
import { ok } from "@/lib/api/envelope";
import { getRaceDay, parseWindowHours } from "@/lib/dashboard/queries";

// GET /api/admin/race-day?window=24h — the content queue: upcoming races whose
// jump time falls within `window` (default 24h, capped at 7d), each with its
// running platform horses annotated with last-post recency + a hasPost flag so
// the operator can see which runners still need a pre-race post.
export async function GET(req: Request) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const windowHours = parseWindowHours(new URL(req.url).searchParams.get("window"));
  const races = await getRaceDay(sb, windowHours);
  return ok(races, { window: `${windowHours}h` });
}
