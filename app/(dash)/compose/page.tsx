import { requireAdminPage } from "@/lib/auth/admin";
import ComposeScreen from "./ComposeScreen";
import type { HorseOption, TrainerOption } from "./types";
import { HORSE_PHOTO_BUCKET, signPhotoMap } from "@/lib/storage/photos";

// The operator's core daily flow. The (dash) layout already gates the tree;
// we call requireAdminPage() again here for the elevated RLS client (`sb`) used
// to read the pickable horses + the full trainer list (Layer A `[PG] GET
// horse`/`trainer`) — reads that need the admin session, which lives in
// httpOnly cookies and is therefore only reachable from the server client.
export const dynamic = "force-dynamic";

type HorseRow = {
  id: string;
  display_name: string | null;
  racing_name: string | null;
  photo_url: string | null;
  stable_name: string | null;
  trainer_id: string | null;
  trainer: { id: string; name: string | null; display_name: string | null } | Array<{
    id: string;
    name: string | null;
    display_name: string | null;
  }> | null;
};

type TrainerRow = { id: string; name: string | null; display_name: string | null };

function one<T>(v: T | T[] | null): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

export default async function ComposePage() {
  const { sb } = await requireAdminPage();

  const [horsesRes, trainersRes] = await Promise.all([
    sb
      .from("horse")
      .select(
        "id,display_name,racing_name,photo_url,stable_name,trainer_id,trainer:trainer_id(id,name,display_name)",
      )
      .eq("status", "active")
      .order("display_name"),
    sb.from("trainer").select("id,name,display_name").order("name"),
  ]);

  const horses: HorseOption[] = ((horsesRes.data as HorseRow[] | null) ?? []).map((h) => {
    const t = one(h.trainer);
    return {
      id: h.id,
      name: h.racing_name ?? h.display_name ?? "Unnamed horse",
      photoUrl: h.photo_url,
      stableName: h.stable_name,
      trainerId: h.trainer_id ?? t?.id ?? null,
      trainerName: t?.name ?? t?.display_name ?? null,
    };
  });

  const trainers: TrainerOption[] = ((trainersRes.data as TrainerRow[] | null) ?? []).map((t) => ({
    id: t.id,
    name: t.name ?? t.display_name ?? "Unnamed trainer",
  }));

  // Private bucket: sign each pickable horse's photo path for display.
  const horsePhotos = await signPhotoMap(sb, HORSE_PHOTO_BUCKET, horses.map((h) => h.photoUrl));
  const signedHorses: HorseOption[] = horses.map((h) => ({
    ...h,
    photoUrl: h.photoUrl ? horsePhotos.get(h.photoUrl) ?? null : null,
  }));

  return <ComposeScreen horses={signedHorses} trainers={trainers} />;
}
