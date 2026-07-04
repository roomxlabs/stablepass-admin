import { requireAdmin } from "@/lib/auth/admin";
import { ok } from "@/lib/api/envelope";
export async function GET() {
  const g = await requireAdmin(); if ("res" in g) return g.res;
  // TODO(ticket): posts/reactions/saves this week, quiet horses (no post > 7d), subscriber counts.
  return ok({ postsThisWeek: 0, reactions: 0, saves: 0, quietHorses: [], subscribers: {} });
}
