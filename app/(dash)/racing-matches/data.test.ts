import { describe, it, expect } from "vitest";
import { pickEvidence, valuesAgree, ageFromFoalingYear } from "./data";

describe("pickEvidence — the no-owner-PII allowlist (guardrail)", () => {
  it("keeps exactly the seven racing-profile fields", () => {
    expect(
      pickEvidence({
        name: "Northern Light",
        sire: "Snitzel",
        dam: "Bel Esprit",
        age: 4,
        sex: "Mare",
        colour: "Bay",
        trainer: "C. Waller",
      }),
    ).toEqual({
      name: "Northern Light",
      sire: "Snitzel",
      dam: "Bel Esprit",
      age: 4,
      sex: "Mare",
      colour: "Bay",
      trainer: "C. Waller",
    });
  });

  it("drops owner PII, odds and any unknown key", () => {
    expect(
      pickEvidence({
        name: "Northern Light",
        owner: "J. Smith",
        owners: ["J. Smith"],
        owner_email: "j@example.com",
        odds: "5/1",
        bookmaker: "Acme",
        somethingNew: "x",
      }),
    ).toEqual({ name: "Northern Light" });
  });

  it("survives a null / non-object / array evidence column", () => {
    expect(pickEvidence(null)).toEqual({});
    expect(pickEvidence(undefined)).toEqual({});
    expect(pickEvidence("nope")).toEqual({});
    expect(pickEvidence(["nope"])).toEqual({});
  });

  it("drops non-scalar values rather than passing an object through", () => {
    expect(pickEvidence({ name: { first: "N" }, sire: ["S"], dam: "Bel Esprit" })).toEqual({
      dam: "Bel Esprit",
    });
  });
});

describe("valuesAgree", () => {
  it("ignores case and surrounding whitespace", () => {
    expect(valuesAgree("Snitzel", " snitzel ")).toBe(true);
    expect(valuesAgree(4, "4")).toBe(true);
  });

  it("treats a genuine difference as a mismatch", () => {
    expect(valuesAgree("Bay", "Chestnut")).toBe(false);
  });

  it("treats a missing value on either side as a mismatch, never a match", () => {
    expect(valuesAgree(null, null)).toBe(false);
    expect(valuesAgree("Snitzel", null)).toBe(false);
    expect(valuesAgree(null, "Snitzel")).toBe(false);
  });
});

describe("ageFromFoalingYear", () => {
  it("derives the age from the year, never storing it", () => {
    expect(ageFromFoalingYear(2022, new Date("2026-07-21T00:00:00Z"))).toBe(4);
  });

  it("returns null when the foaling year is unknown", () => {
    expect(ageFromFoalingYear(null)).toBe(null);
  });
});
