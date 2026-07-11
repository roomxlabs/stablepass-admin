import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth/admin";
import HorseForm, { type Trainer, type HorseInitial } from "../../HorseForm";
import "../../horses.css";

// Edit horse — reuses the add-horse form (there is no separate edit mockup),
// prefilled from the row and issuing PATCH /api/admin/horses/:id (+ /stats).
export default async function EditHorsePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { sb } = await requireAdminPage();
  const { id } = await params;

  const [{ data: horse }, { data: trainerRows }] = await Promise.all([
    sb.from("horse").select("*").eq("id", id).maybeSingle(),
    sb.from("trainer").select("id, display_name, stable_name").order("display_name", { ascending: true }),
  ]);

  if (!horse) notFound();
  const trainers = (trainerRows ?? []) as Trainer[];

  const initial: HorseInitial = {
    trainerId: horse.trainer_id ?? "",
    stableName: horse.stable_name ?? horse.display_name ?? "",
    racingName: horse.racing_name ?? "",
    foalingYear: horse.foaling_year ? String(horse.foaling_year) : "",
    sex: horse.sex ?? "gelding",
    colour: horse.colour ?? "",
    sire: horse.sire ?? "",
    dam: horse.dam ?? "",
    starts: horse.starts != null ? String(horse.starts) : "",
    wins: horse.wins != null ? String(horse.wins) : "",
    places: horse.places != null ? String(horse.places) : "",
    prize: horse.prize_money_cents ? String(Math.round(horse.prize_money_cents / 100)) : "",
    story: horse.story ?? "",
    photoUrl: horse.photo_url ?? "",
    status: horse.status ?? "active",
    trainingStatus: horse.training_status ?? "spelling",
  };

  return <HorseForm mode="edit" horseId={id} trainers={trainers} initial={initial} />;
}
