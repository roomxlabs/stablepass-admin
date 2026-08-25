import Link from "next/link";
import { notFound } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import TrainerForm, { type ContactInput, type TrainerData } from "../../TrainerForm";
import DangerDelete from "../../../DangerDelete";
import { blockedMessage } from "@/lib/api/references";
import {
  countTrainerReferences,
  toTrainerFormSeed,
  TRAINER_DETAIL_COLUMNS,
  type TrainerDetailRow,
} from "../../data";
import "../../trainers.css";

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
    .select(TRAINER_DETAIL_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (!t) notFound();

  const { data: cRows } = await sb
    .from("trainer_contact")
    .select("id,role,name,email,phone")
    .eq("trainer_id", id)
    .order("created_at", { ascending: true });

  // ENG-766: the mapping lives in ./data so it is unit-testable — it seeds the
  // "Show on marketing site" checkbox and tells the form which public object it
  // is already responsible for.
  // Pre-count both blocking paths for the Danger zone, so a refused delete is a
  // disabled button with a reason rather than an opaque 23503 after the click.
  const refs = await countTrainerReferences(sb, id);
  const blockedReason = blockedMessage("trainer", [
    { count: refs.posts, singular: "post", plural: "posts" },
    { count: refs.horses, singular: "horse", plural: "horses" },
  ]);

  const trainer: TrainerData = toTrainerFormSeed(t as TrainerDetailRow);
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
        {/* Outside TrainerForm — that component is one <form>, and a delete
            must never be reachable by submitting it. */}
        <DangerDelete
          testId="delete-trainer"
          endpoint={`/api/admin/trainers/${id}`}
          redirectTo="/trainers"
          heading="Delete trainer"
          description="Removes the trainer from the database, with their internal contacts. Delete their posts first, then their horses."
          confirmText={
            `Permanently delete ${trainer.displayName || trainer.name}?\n\n` +
            "This removes the trainer and their internal contacts from the database. It CANNOT be undone."
          }
          blockedReason={blockedReason}
        />
      </div>
    </>
  );
}
