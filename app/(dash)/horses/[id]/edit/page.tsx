import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth/admin";
import HorseForm, { type Trainer, type HorseInitial } from "../../HorseForm";
import DangerDelete from "../../../DangerDelete";
import { blockedMessage } from "@/lib/api/references";
import { fetchHorseForEdit, fetchTrainerOptions, countPostsForHorse } from "../../data";
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
  const [horseRow, trainerRows, postCount] = await Promise.all([
    fetchHorseForEdit(sb, id),
    fetchTrainerOptions(sb),
    // Pre-count for the Danger zone below: `post.horse_id` is not-null with no
    // ON DELETE, so this decides whether the delete can be offered at all.
    countPostsForHorse(sb, id),
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
    sharesForSale: horse.shares_for_sale === true,
  };

  const blockedReason = blockedMessage("horse", [
    { count: postCount, singular: "post", plural: "posts" },
  ]);

  return (
    <>
      <HorseForm mode="edit" horseId={id} trainers={trainers} initial={initial} />
      {/* Sits OUTSIDE HorseForm because that component is one big <form> and a
          delete must never be reachable by submitting it. */}
      <div className="admin-content" style={{ paddingTop: 0 }}>
        <DangerDelete
          testId="delete-horse"
          endpoint={`/api/admin/horses/${id}`}
          redirectTo="/horses"
          heading="Delete horse"
          description="Removes the horse from the database. Its followers, notification opt-ins and race entries go with it. Delete its posts first."
          confirmText={
            `Permanently delete ${initial.stableName || "this horse"}?\n\n` +
            "This removes the horse, its followers, its notification opt-ins and its race entries from the database. It CANNOT be undone."
          }
          blockedReason={blockedReason}
        />
      </div>
    </>
  );
}
