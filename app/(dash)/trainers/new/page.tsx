import Link from "next/link";
import TrainerForm from "../TrainerForm";

// Add trainer — matches mockups/web/admin/screens/08-add-trainer.html. Gated by
// the (dash) layout (requireAdminPage). The form posts to the admin trainer +
// contacts endpoints, all behind requireAdmin.
export default function NewTrainerPage() {
  return (
    <>
      <div className="admin-topbar">
        <h1 className="adm-crumb">
          <Link href="/trainers">Trainers</Link>
          <span className="sep">›</span>
          Add trainer
        </h1>
        <div className="actions">
          <Link href="/trainers" className="adm-topbar-link">Cancel</Link>
        </div>
      </div>
      <div className="admin-content">
        <TrainerForm mode="create" />
      </div>
    </>
  );
}
