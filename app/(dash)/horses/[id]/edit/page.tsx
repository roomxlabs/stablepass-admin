import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth/admin";
import HorseForm, { type Trainer, type HorseInitial } from "../../HorseForm";
import { fetchHorseForEdit, fetchTrainerOptions } from "../../data";
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

  // Both helpers THROW on a query error rather than returning empty, so an RLS
  // regression cannot present itself as "this horse doesn't exist".
  const [horseRow, trainerRows] = await Promise.all([
    fetchHorseForEdit(sb, id),
    fetchTrainerOptions(sb),
  ]);

  if (!horseRow) notFound();
  const horse = horseRow;
  const trainers = trainerRows as Trainer[];

  const initial: HorseInitial = {
    trainerId: horse.trainer_id ?? "",
    stableName: horse.stable_name ?? horse.display_name ?? "",
    racingName: horse.racing_name ?? "",
    foalingYear: horse.foaling_year ? String(horse.foaling_year) : "",
    // A NULL sex prefills as NO SELECTION (ENG-616). H1's backfill nulled every
    // legacy value it could not map honestly; defaulting those rows to Male in
    // the form would launder a guess straight back into the database.
    sex: horse.sex ?? "",
    isGelded: horse.is_gelded === true,
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
