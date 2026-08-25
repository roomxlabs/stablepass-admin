import { fail } from "@/lib/api/envelope";
import { trainerHasWebsite } from "@/lib/trainers/website-url";

// ENG-829 — Shares for-sale flag on horse, gated on the trainer's public website.
// The member Shares CTA points at trainer.website_url only (not trainer_contact).

/** Shown in the form and returned by both horse write routes on a 400. */
export const SHARES_WEBSITE_REQUIRED =
  "Set this trainer's website first — the Shares contact button needs somewhere to point.";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySb = { from: (table: string) => any };

/**
 * When the admin asks to set shares_for_sale=true, confirm the horse's trainer
 * has a usable website_url. Returns a 400 Response on failure, or null to proceed.
 * Turning the flag OFF never needs a website.
 */
export async function rejectSharesWithoutTrainerWebsite(
  sb: AnySb,
  trainerId: string,
): Promise<Response | null> {
  const { data, error } = await sb
    .from("trainer")
    .select("website_url")
    .eq("id", trainerId)
    .maybeSingle();
  if (error) {
    console.error("[horses] trainer website lookup failed", { code: error.code });
    return fail("query_failed", "Could not verify the trainer's website.", 500);
  }
  if (!data) return fail("validation_failed", "trainerId not found.", 400, { trainerId: "not_found" });
  if (!trainerHasWebsite(data.website_url)) {
    return fail("validation_failed", SHARES_WEBSITE_REQUIRED, 400, { sharesForSale: "website_required" });
  }
  return null;
}

/** Resolve the horse's trainer_id for a PATCH gate (trainer is fixed for life of row). */
export async function trainerIdForHorse(
  sb: AnySb,
  horseId: string,
): Promise<{ ok: true; trainerId: string } | { ok: false; res: Response }> {
  const { data, error } = await sb
    .from("horse")
    .select("trainer_id")
    .eq("id", horseId)
    .maybeSingle();
  if (error) {
    console.error("[horses] trainer_id lookup failed", { code: error.code });
    return { ok: false, res: fail("query_failed", "Could not verify the horse's trainer.", 500) };
  }
  if (!data) return { ok: false, res: fail("not_found", "Horse not found.", 404) };
  if (!data.trainer_id) {
    return { ok: false, res: fail("validation_failed", "Horse has no trainer assigned.", 400) };
  }
  return { ok: true, trainerId: data.trainer_id };
}

/** Parse the request body's sharesForSale. Absent → undefined (leave / default). */
export function parseSharesForSale(
  raw: unknown,
): { ok: true; value: boolean | undefined } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "boolean") {
    return { ok: false, message: "sharesForSale must be a boolean." };
  }
  return { ok: true, value: raw };
}
