import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth/admin";
import RaceDetail, { type Runner } from "./RaceDetail";
import type { RaceRow } from "../format";
import "../racing-manual.css";

// Manage one race (RF6 / ENG-180): correct it, attach runners, enter results, or
// remove it. Re-asserts requireAdminPage() — the (dash) layout gate does not cover
// a page's own data fetch.

type HorseOption = { id: string; display_name: string; racing_name: string | null };

export default async function ManualRacePage({ params }: { params: Promise<{ id: string }> }) {
  const { sb } = await requireAdminPage();
  const { id } = await params;

  const { data: race, error } = await sb
    .from("race")
    .select(
      "id, venue, race_date, race_number, race_class, distance_m, scheduled_at, status, source, manual_override, finished_at",
    )
    .eq("id", id)
    .maybeSingle();

  // Distinguish a failed read from a genuinely missing race: swallowing the error
  // would render a misleading 404 for what is actually an RLS/schema fault.
  if (error) throw new Error(`Could not load race ${id}`);
  if (!race) notFound();

  const { data: runnerRows } = await sb
    .from("race_horse")
    .select(
      "id, race_id, horse_id, barrier, jockey, result, finish_position, entry_status, horse:horse_id(display_name, racing_name)",
    )
    .eq("race_id", id);

  // Horses the operator can attach. No owner field exists on `horse` and none is
  // selected here (guardrail §4: admin never reads or stores owner PII).
  const { data: horseRows } = await sb
    .from("horse")
    .select("id, display_name, racing_name")
    .order("display_name", { ascending: true });

  return (
    <RaceDetail
      race={race as RaceRow}
      runners={(runnerRows ?? []) as Runner[]}
      horses={(horseRows ?? []) as HorseOption[]}
    />
  );
}
