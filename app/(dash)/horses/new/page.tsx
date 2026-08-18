import { requireAdminPage } from "@/lib/auth/admin";
import HorseForm, { type Trainer } from "../HorseForm";
import { fetchTrainerOptions } from "../data";
import "../horses.css";

// Add horse — screens/07-add-horse.html. Fetches the trainer dropdown options
// (gated read) then hands off to the shared client form which POSTs to
// /api/admin/horses.
export default async function NewHorsePage() {
  const { sb } = await requireAdminPage();
  const trainers = (await fetchTrainerOptions(sb)) as Trainer[];

  return <HorseForm mode="create" trainers={trainers} />;
}
