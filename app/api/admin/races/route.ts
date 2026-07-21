import { requireAdmin } from "@/lib/auth/admin";
import { ok, created, fail } from "@/lib/api/envelope";
import { NATURAL_KEY, STRING_ONLY_COLUMNS, blankNaturalKeyMessage, normalizeNaturalKeyValue } from "@/lib/racing/natural-key";

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

  // Every natural-key component is required AND normalized before anything else. A falsy
  // check (`if (!b?.venue)`) let "   " through untrimmed, so two "identical" races differing
  // only by padding both inserted cleanly and the 409 below never fired. Shared with the PATCH
  // route via lib/racing/natural-key.ts so the invariant has ONE implementation.
  // NATURAL_KEY maps column -> the camelCase request field, so it is the ONLY list of the
  // components; do not hand-roll a second one here or the two drift (which is this ticket).
  const key: Record<string, unknown> = {};
  for (const [column, field] of Object.entries(NATURAL_KEY)) {
    const n = normalizeNaturalKeyValue(b?.[field], { stringOnly: STRING_ONLY_COLUMNS.has(column) });
    if (!n.ok) return fail("validation_failed", blankNaturalKeyMessage(field), 400);
    key[column] = n.value;
  }

  // raceNumber MUST be a real integer. `Number("abc")` is NaN, which JSON-serialises
  // to null — and a NULL participates in no unique match, so an unvalidated value
  // would silently punch straight through the natural-key dedup this route exists to
  // enforce.
  const raceNumber = Number(key.race_number);
  if (!Number.isInteger(raceNumber) || raceNumber < 1)
    return fail("validation_failed", "raceNumber must be a positive integer.", 400);

  const hasDistance = b.distanceM != null && b.distanceM !== "";
  const distanceM = hasDistance ? Number(b.distanceM) : null;
  if (distanceM != null && (!Number.isInteger(distanceM) || distanceM < 0))
    return fail("validation_failed", "distanceM must be a non-negative integer.", 400);

  const { data, error } = await sb
    .from("race")
    .insert({
      venue: key.venue,
      race_date: key.race_date,
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
