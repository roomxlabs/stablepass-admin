import { requireAdminPage } from "@/lib/auth/admin";
import RaceForm from "../RaceForm";
import "../racing-manual.css";

export default async function NewManualRacePage() {
  await requireAdminPage();
  return <RaceForm />;
}
