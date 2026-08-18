// Server-side validation of the sex / gelded pair, shared by POST /horses and
// PATCH /horses/:id (ENG-616).
//
// The BFF is not the only possible caller and Postgres's own CHECK surfaces as
// a raw 23514 with a constraint name in it — not a usable error message. So the
// rule is enforced HERE as well, as a 400 `validation_failed`, and the CHECK
// stays as the backstop. The shipped constraint (ENG-615) is:
//
//   check (not is_gelded or sex is not distinct from 'male')
//
// Note `is not distinct from`, NOT `=`. With `=`, a row of
// `is_gelded = true, sex = NULL` evaluates to NULL and a CHECK ACCEPTS NULL —
// the migration rejected that form deliberately. Do not "simplify" it back.
//
// The pairing is enforced in BOTH directions, because they are the same bug
// seen from two sides:
//   - setting `isGelded` true against a non-male sex is rejected outright;
//   - setting `sex` to anything but male CLEARS `is_gelded`, exactly as the
//     form does, so a stored gelding cannot be stranded as a gelded female.

export const HORSE_SEXES = ["male", "female"] as const;
export type HorseSex = (typeof HORSE_SEXES)[number];

export type SexFieldsError = { field: string; message: string };

export type SexFieldsResult =
  | { ok: true; columns: Record<string, unknown> }
  | { ok: false; error: SexFieldsError };

function isHorseSex(v: unknown): v is HorseSex {
  return typeof v === "string" && (HORSE_SEXES as readonly string[]).includes(v);
}

// Validates whichever of `sex` / `isGelded` the body carries and maps them to
// their columns. Absent keys stay absent, so a PATCH that touches neither is
// unaffected.
export function sexColumns(b: Record<string, unknown>): SexFieldsResult {
  const columns: Record<string, unknown> = {};

  const hasSex = "sex" in b;
  if (hasSex) {
    const sex = b.sex;
    if (sex !== null && sex !== undefined && !isHorseSex(sex)) {
      return {
        ok: false,
        error: {
          field: "sex",
          // Deliberately does NOT name the old descriptions as alternatives:
          // 'gelding'/'colt'/'filly'/'mare'/'stallion' are no longer sexes.
          message: "sex must be 'male', 'female' or null.",
        },
      };
    }
    columns.sex = sex ?? null;
  }

  if (!("isGelded" in b)) {
    // The caller moved the sex without mentioning gelding. Clear the flag in the
    // same write, exactly as the form does — otherwise a stored gelding turned
    // female keeps `is_gelded = true`, the CHECK rejects the row, and the raw
    // 23514 lands in front of the operator. Absent `sex`, there is nothing to
    // reconcile and `is_gelded` is left alone.
    if (hasSex && columns.sex !== "male") columns.is_gelded = false;
    return { ok: true, columns };
  }

  {
    const isGelded = b.isGelded;
    if (typeof isGelded !== "boolean") {
      return { ok: false, error: { field: "isGelded", message: "isGelded must be a boolean." } };
    }
    if (isGelded) {
      // A gelding is a gelded MALE at any age. `sex` must be stated in the same
      // request: without it we would be writing `is_gelded = true` against an
      // unknown sex and letting the CHECK decide, which is the raw-23514 case
      // this validation exists to prevent.
      const sex = hasSex ? b.sex : undefined;
      if (sex !== "male") {
        return {
          ok: false,
          error: {
            field: "isGelded",
            message: "isGelded may only be true when sex is 'male'.",
          },
        };
      }
    }
    columns.is_gelded = isGelded;
  }

  return { ok: true, columns };
}
