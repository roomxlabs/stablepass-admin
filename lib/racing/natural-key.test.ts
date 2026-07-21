import { describe, it, expect } from "vitest";
import {
  NATURAL_KEY,
  STRING_ONLY_COLUMNS,
  blankNaturalKeyMessage,
  normalizeNaturalKeyValue,
} from "./natural-key";

describe("normalizeNaturalKeyValue", () => {
  it("rejects absent values", () => {
    expect(normalizeNaturalKeyValue(null)).toEqual({ ok: false });
    expect(normalizeNaturalKeyValue(undefined)).toEqual({ ok: false });
  });

  it("rejects empty and whitespace-only strings", () => {
    expect(normalizeNaturalKeyValue("")).toEqual({ ok: false });
    expect(normalizeNaturalKeyValue("   ")).toEqual({ ok: false });
    expect(normalizeNaturalKeyValue("\t\n ")).toEqual({ ok: false });
  });

  it("trims a padded string — padding defeats the unique index like a NULL does", () => {
    expect(normalizeNaturalKeyValue("  Rosehill  ")).toEqual({ ok: true, value: "Rosehill" });
    expect(normalizeNaturalKeyValue("Rosehill")).toEqual({ ok: true, value: "Rosehill" });
  });

  // PATCH (ENG-324) relies on this tolerance; do not tighten it without re-opening that ticket.
  it("passes non-strings through by default", () => {
    expect(normalizeNaturalKeyValue(5)).toEqual({ ok: true, value: 5 });
    expect(normalizeNaturalKeyValue(0)).toEqual({ ok: true, value: 0 });
    expect(normalizeNaturalKeyValue(false)).toEqual({ ok: true, value: false });
  });

  // Create opts in, restoring the strictness its original falsy check had.
  it("rejects non-strings under stringOnly", () => {
    for (const v of [0, 5, false, true, {}, [], NaN]) {
      expect(normalizeNaturalKeyValue(v, { stringOnly: true })).toEqual({ ok: false });
    }
    expect(normalizeNaturalKeyValue("  Rosehill  ", { stringOnly: true })).toEqual({
      ok: true,
      value: "Rosehill",
    });
  });

  it("names the natural-key columns and the string-only subset", () => {
    expect(NATURAL_KEY).toEqual({ venue: "venue", race_date: "raceDate", race_number: "raceNumber" });
    expect([...STRING_ONLY_COLUMNS].sort()).toEqual(["race_date", "venue"]);
    expect(blankNaturalKeyMessage("venue")).toBe("venue is required and cannot be blank.");
  });
});
