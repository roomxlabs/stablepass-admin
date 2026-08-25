import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HORSE_SEXES, horseSexLabel, horseSubtitle, statusPillClass } from "../format";

describe("horseSubtitle — composed from DB-supplied values", () => {
  const base = { trainerName: "Chris Waller", trainingStatus: "racing" as string | null };

  it("renders 5yo gelding", () => {
    expect(horseSubtitle({ ...base, age: 5, description: "gelding" })).toBe("by Chris Waller · 5yo gelding");
  });

  it("renders 3yo filly", () => {
    expect(horseSubtitle({ ...base, age: 3, description: "filly" })).toBe("by Chris Waller · 3yo filly");
  });

  it("renders 4yo mare", () => {
    expect(horseSubtitle({ ...base, age: 4, description: "mare" })).toBe("by Chris Waller · 4yo mare");
  });

  it("renders 2yo colt", () => {
    expect(horseSubtitle({ ...base, age: 2, description: "colt" })).toBe("by Chris Waller · 2yo colt");
  });

  it("renders 6yo horse for an entire adult male", () => {
    expect(horseSubtitle({ ...base, age: 6, description: "horse" })).toBe("by Chris Waller · 6yo horse");
  });

  it("keeps the retired special case: status wins and the age is dropped", () => {
    // Sourced from training_status, NOT from sex — the database derivation does
    // not cover it, so deleting this branch would silently lose it.
    expect(horseSubtitle({ trainerName: "Chris Waller", age: 14, description: "mare", trainingStatus: "retired" })).toBe(
      "by Chris Waller · retired",
    );
  });

  it("degrades to the trainer alone when there is no foaling year and no description", () => {
    expect(horseSubtitle({ ...base, age: null, description: null })).toBe("by Chris Waller");
  });

  it("still shows gelding with no foaling year (gelding is age-independent)", () => {
    expect(horseSubtitle({ ...base, age: null, description: "gelding" })).toBe("by Chris Waller · gelding");
  });

  it("shows the age alone if the description is unknown but the age is not", () => {
    expect(horseSubtitle({ ...base, age: 5, description: null })).toBe("by Chris Waller · 5yo");
  });

  it("falls back to 'Unassigned trainer'", () => {
    expect(horseSubtitle({ trainerName: null, age: 5, description: "gelding", trainingStatus: "racing" })).toBe(
      "Unassigned trainer · 5yo gelding",
    );
  });

  it("lower-cases whatever description the database hands back", () => {
    expect(horseSubtitle({ ...base, age: 5, description: "Gelding" })).toBe("by Chris Waller · 5yo gelding");
  });

  it("passes an age of 0 straight through (the DB collapses 0 to null, so this is unreachable in practice)", () => {
    // horse_age() is `nullif(greatest(0, …), 0)`, so Postgres never emits 0.
    // Pinned anyway: the composer must not special-case a value it is given.
    expect(horseSubtitle({ ...base, age: 0, description: "colt" })).toBe("by Chris Waller · 0yo colt");
  });
});

describe("sex options", () => {
  it("offers exactly male and female — stallion is gone", () => {
    expect(HORSE_SEXES).toEqual(["male", "female"]);
  });

  it("labels them Male and Female", () => {
    expect(HORSE_SEXES.map(horseSexLabel)).toEqual(["Male", "Female"]);
  });
});

describe("statusPillClass", () => {
  it("gives racing the dotted green pill", () => {
    expect(statusPillClass("racing")).toBe("pill green dot");
    expect(statusPillClass("retired")).toBe("pill");
  });
});

// ---------------------------------------------------------------------------
// Grep guard. The whole point of ENG-616 is that the age rule stops existing in
// three places, so the TypeScript copies must be GONE, not merely unused. The
// needles are assembled at runtime so this file does not match itself.
const HERE = dirname(fileURLToPath(import.meta.url)); // app/(dash)/horses/__tests__
const REPO_ROOT = join(HERE, "..", "..", "..", "..");
const SKIP = new Set(["node_modules", ".next", ".git", ".claude", "playwright-report", "test-results"]);
const EXTS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx"];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (EXTS.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

describe("the deleted TypeScript age formula", () => {
  const needles = [["compute", "Age"].join(""), ["horse", "Meta"].join("")];

  it.each(needles)("%s no longer exists anywhere in the repo", (needle) => {
    const offenders = sourceFiles(REPO_ROOT).filter((f) => readFileSync(f, "utf8").includes(needle));
    expect(offenders.map((f) => f.slice(REPO_ROOT.length + 1))).toEqual([]);
  });
});
