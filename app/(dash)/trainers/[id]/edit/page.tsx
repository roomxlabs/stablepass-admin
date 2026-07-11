import Link from "next/link";
import { notFound } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import TrainerForm, { type ContactInput, type TrainerData } from "../../TrainerForm";

// Edit trainer — reuses the add-trainer form (mockup 08), pre-filled. Loads the
// trainer + its internal contacts server-side (admin RLS) and hands them to the
// shared form, which PATCHes the profile and reconciles contacts.
export const dynamic = "force-dynamic";

export default async function EditTrainerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const sb = await supabaseServer();

  const { data: t } = await sb
    .from("trainer")
    .select("id,name,display_name,stable_name,location,bio,photo_url,status")
    .eq("id", id)
    .maybeSingle();
  if (!t) notFound();

  const { data: cRows } = await sb
    .from("trainer_contact")
    .select("id,role,name,email,phone")
    .eq("trainer_id", id)
    .order("created_at", { ascending: true });

  const trainer: TrainerData = {
    id: t.id,
    name: t.name,
    displayName: t.display_name ?? "",
    stableName: t.stable_name ?? "",
    location: t.location ?? "",
    bio: t.bio ?? "",
    photoUrl: t.photo_url ?? null,
    status: t.status === "onboarding" ? "onboarding" : "active",
  };
  const contacts: ContactInput[] = ((cRows ?? []) as Record<string, string>[]).map((c) => ({
    id: c.id,
    role: c.role ?? "",
    name: c.name ?? "",
    email: c.email ?? "",
    phone: c.phone ?? "",
  }));

  return (
    <>
      <div className="admin-topbar">
        <h1 className="adm-crumb">
          <Link href="/trainers">Trainers</Link>
          <span className="sep">›</span>
          {trainer.displayName || trainer.name}
        </h1>
        <div className="actions">
          <Link href="/trainers" className="adm-topbar-link">Cancel</Link>
        </div>
      </div>
      <div className="admin-content">
        <TrainerForm mode="edit" trainer={trainer} contacts={contacts} />
      </div>
    </>
  );
}
