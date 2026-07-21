import { requireAdmin } from "@/lib/auth/admin";
import { ok, created, fail } from "@/lib/api/envelope";

// Manual race override (RF6 / ENG-180). The Racing API feed (RF3) is the primary
// source; these routes are the fallback for pre-API history, unmatched horses,
// feed outages, and corrections that must stick.
//
// Guardrail: requireAdmin() first on every handler. No odds / betting / bookmaker
// fields exist anywhere in this surface, and no owner PII is read or written.

// GET /api/admin/races — the manual-override list screen. Newest jump first.
export async function GET(req: Request) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const sp = new URL(req.url).searchParams;
  const source = sp.get("source");

  let query = sb
    .from("race")
    .select(
      "id, venue, race_date, race_number, race_class, distance_m, scheduled_at, status, source, manual_override, finished_at",
    )
    .order("race_date", { ascending: false });

  if (source === "manual" || source === "api") query = query.eq("source", source);

  const { data, error } = await query;
  if (error) return fail("read_failed", error.message, 400);
  return ok(data ?? []);
}

// POST /api/admin/races — create a race the feed doesn't have, source='manual'.
// The natural key (venue, race_date, race_number) is enforced by the DB so we can
// never end up with two rows for one real race — including against an existing
// `api` row. Venue + number are required here (not just race_date) because a NULL
// participates in no unique match, which would silently defeat that dedup.
export async function POST(req: Request) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const b = await req.json().catch(() => ({}));
  if (!b?.raceDate) return fail("validation_failed", "raceDate is required.", 400);
  if (!b?.venue) return fail("validation_failed", "venue is required.", 400);
  if (b?.raceNumber == null || b.raceNumber === "")
    return fail("validation_failed", "raceNumber is required.", 400);

  // raceNumber MUST be a real integer. `Number("abc")` is NaN, which JSON-serialises
  // to null — and a NULL participates in no unique match, so an unvalidated value
  // would silently punch straight through the natural-key dedup this route exists to
  // enforce.
  const raceNumber = Number(b.raceNumber);
  if (!Number.isInteger(raceNumber) || raceNumber < 1)
    return fail("validation_failed", "raceNumber must be a positive integer.", 400);

  const hasDistance = b.distanceM != null && b.distanceM !== "";
  const distanceM = hasDistance ? Number(b.distanceM) : null;
  if (distanceM != null && (!Number.isInteger(distanceM) || distanceM < 0))
    return fail("validation_failed", "distanceM must be a non-negative integer.", 400);

  const { data, error } = await sb
    .from("race")
    .insert({
      venue: b.venue,
      race_date: b.raceDate,
      race_number: raceNumber,
      race_class: b.raceClass ?? null,
      distance_m: distanceM,
      scheduled_at: b.scheduledAt ?? null,
      status: "upcoming",
      source: "manual",
    })
    .select("id, venue, race_date, race_number, status, source")
    .single();

  if (error) {
    // 23505 = unique_violation on race_natural_key: a race (manual OR api) already
    // exists for this venue/date/number. Never create the duplicate.
    if (error.code === "23505")
      return fail(
        "race_exists",
        "A race already exists for that venue, date and race number.",
        409,
      );
    return fail("insert_failed", error.message, 400);
  }
  return created(data);
}
