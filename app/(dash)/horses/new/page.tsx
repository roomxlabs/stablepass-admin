import { requireAdminPage } from "@/lib/auth/admin";
import HorseForm, { type Trainer } from "../HorseForm";
import "../horses.css";

// Add horse — screens/07-add-horse.html. Fetches the trainer dropdown options
// (gated read) then hands off to the shared client form which POSTs to
// /api/admin/horses.
export default async function NewHorsePage() {
  const { sb } = await requireAdminPage();
  const { data } = await sb
    .from("trainer")
    .select("id, display_name, stable_name")
    .order("display_name", { ascending: true });
  const trainers = (data ?? []) as Trainer[];

  return <HorseForm mode="create" trainers={trainers} />;
}
