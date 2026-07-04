import { requireAdmin } from "@/lib/auth/admin";
import { created, fail } from "@/lib/api/envelope";
// Horse-first: find-or-create the race event (dedup venue+date+number) + attach runner.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin(); if ("res" in g) return g.res; const { sb } = g;
  const { id: horseId } = await params; const b = await req.json();
  // TODO(ticket): upsert race on (venue,race_date,race_number); then insert race_horse runner.
  void sb; void horseId;
  return created({ race: null, raceHorse: null });
}
