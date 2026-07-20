import { describe, it, expect } from "vitest";
import {
  formatPrize,
  raceMeta,
  raceTitle,
  runnerStatusPill,
  sourcePill,
  statusPill,
} from "./format";

describe("raceTitle / raceMeta", () => {
  it("renders venue + race number", () => {
    expect(raceTitle({ venue: "Randwick", race_number: 5 })).toBe("Randwick R5");
  });
  it("degrades when parts are missing", () => {
    expect(raceTitle({ venue: "Randwick", race_number: null })).toBe("Randwick");
    expect(raceTitle({ venue: null, race_number: null })).toBe("Unknown venue");
  });
  it("joins class and distance, omitting blanks", () => {
    expect(raceMeta({ race_class: "BM78", distance_m: 1400 })).toBe("BM78 · 1400m");
    expect(raceMeta({ race_class: null, distance_m: 1400 })).toBe("1400m");
    expect(raceMeta({ race_class: null, distance_m: null })).toBe("");
  });
});

// Provenance is the point of this screen: a corrected feed row must read
// differently from an untouched one.
describe("sourcePill", () => {
  it("labels a manual row", () => {
    expect(sourcePill({ source: "manual", manual_override: false }).label).toBe("Manual");
  });
  it("labels an untouched feed row", () => {
    expect(sourcePill({ source: "api", manual_override: false }).label).toBe("Feed");
  });
  it("labels a pinned feed row", () => {
    expect(sourcePill({ source: "api", manual_override: true }).label).toBe("Feed · overridden");
  });
});

describe("statusPill / runnerStatusPill", () => {
  it("maps race status", () => {
    expect(statusPill("finished").label).toBe("Finished");
    expect(statusPill("upcoming").label).toBe("Upcoming");
  });
  it("maps every entry_status in the schema CHECK", () => {
    expect(runnerStatusPill("nominated").label).toBe("Nominated");
    expect(runnerStatusPill("confirmed").label).toBe("Confirmed");
    expect(runnerStatusPill("ran").label).toBe("Ran");
    expect(runnerStatusPill("scratched").label).toBe("Scratched");
    expect(runnerStatusPill("not_accepted").label).toBe("Not accepted");
  });
});

describe("formatPrize", () => {
  it("renders cents as whole dollars", () => {
    expect(formatPrize(750_000)).toBe("$7,500");
  });
  it("renders nothing for zero or null", () => {
    expect(formatPrize(0)).toBe("—");
    expect(formatPrize(null)).toBe("—");
  });
});
