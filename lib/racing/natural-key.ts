// The components of `race_natural_key UNIQUE (venue, race_date, race_number)` — the only thing
// guaranteeing one row per real race. Column → the camelCase field to name in errors.
export const NATURAL_KEY: Record<string, string> = {
  venue: "venue",
  race_date: "raceDate",
  race_number: "raceNumber",
};

// `venue` (text) and `race_date` (date) are string columns: a JSON number/boolean/object there is
// junk, so the shared helper must be able to reject it. Note this deliberately TIGHTENS create
// rather than restoring it. The original guard was a plain falsy check (`if (!b?.venue)`), which
// rejected only the falsy non-strings — `0` and `false` (alongside `null`/`undefined`/`""`) — and
// let every truthy non-string through: `7`, `true`, `{}` and `[]` all reached the insert. Tightening
// that is wanted (none of those is a natural key), but it is a behaviour change, not a restoration.
// `race_number` legitimately arrives as a JSON number, so it stays type-tolerant and is
// range-checked by its caller.
export const STRING_ONLY_COLUMNS: ReadonlySet<string> = new Set(["venue", "race_date"]);

// The single message for a missing/blank natural-key component. This route family has several
// 400 branches that all return `validation_failed`, so the MESSAGE is the only discriminator —
// keep it distinct from the "must be a positive integer" branch.
export function blankNaturalKeyMessage(field: string): string {
  return `${field} is required and cannot be blank.`;
}

export type NormalizedKey = { ok: true; value: unknown } | { ok: false };

// A natural-key component is unusable if it is absent, or a string that is empty/whitespace-only:
// in Postgres a NULL participates in no unique match, and "  Rosehill  " and "Rosehill" are
// DISTINCT values under the unique index — so storing padding defeats dedup exactly the way a
// NULL does. Normalizing here (the server is the trust boundary) is integrity, not cosmetics.
//
// Extracted from the PATCH route (ENG-324) so create and PATCH share ONE implementation of the
// invariant; two copies is what let the create route drift (ENG-326).
//
// `stringOnly` additionally rejects non-string input. Create passes it for venue/race_date, which
// goes BEYOND the strictness its old falsy check had (see above). PATCH deliberately does NOT pass
// it: ENG-324 shipped the type-tolerant form and changing that is out of this ticket's scope
// (follow-up noted in .rx/gotchas.md).
export function normalizeNaturalKeyValue(
  v: unknown,
  opts: { stringOnly?: boolean } = {},
): NormalizedKey {
  if (v === null || v === undefined) return { ok: false };
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? { ok: false } : { ok: true, value: t };
  }
  if (opts.stringOnly) return { ok: false };
  return { ok: true, value: v };
}
