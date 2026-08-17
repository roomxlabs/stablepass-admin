// The race-day badge must be DATA-DRIVEN. It was hardcoded on every post
// before ENG-558, and the loader is an async server component, so without
// these tests the regression (`racesToday: true`) sails through the suite.
import { describe, expect, it } from "vitest";
import { one, racingHorseIds, toHorseOptions, toTrainerOptions, type HorseRow } from "./data";

function horse(id: string, over: Partial<HorseRow> = {}): HorseRow {
  return {
    id,
    display_name: `Horse ${id}`,
    racing_name: null,
    photo_url: null,
    stable_name: "Randwick",
    trainer_id: "t1",
    trainer: { id: "t1", name: "Chris Waller", display_name: "Chris Waller" },
    ...over,
  };
}

describe("racingHorseIds", () => {
  it("collects every runner across today's races", () => {
    const set = racingHorseIds([
      { race_horse: [{ horse_id: "h1" }, { horse_id: "h2" }] },
      { race_horse: [{ horse_id: "h3" }] },
    ]);
    expect([...set].sort()).toEqual(["h1", "h2", "h3"]);
  });

  it("dedupes a horse entered in two races on the same day", () => {
    expect(racingHorseIds([{ race_horse: [{ horse_id: "h1" }] }, { race_horse: [{ horse_id: "h1" }] }]).size).toBe(1);
  });

  it("is empty for no races, an empty field, or a failed read", () => {
    expect(racingHorseIds([]).size).toBe(0);
    expect(racingHorseIds([{ race_horse: null }]).size).toBe(0);
    expect(racingHorseIds(null).size).toBe(0);
  });
});

describe("toHorseOptions — racesToday", () => {
  it("flags ONLY the horses that appear in today's races", () => {
    const options = toHorseOptions([horse("h1"), horse("h2")], new Set(["h1"]));
    expect(options.map((o) => [o.id, o.racesToday])).toEqual([
      ["h1", true],
      ["h2", false],
    ]);
  });

  it("flags nothing when no horse races today", () => {
    const options = toHorseOptions([horse("h1"), horse("h2")], new Set());
    expect(options.every((o) => o.racesToday === false)).toBe(true);
  });

  it("flags nothing when the race read failed", () => {
    // racingHorseIds(null) must not become "everything races today".
    const options = toHorseOptions([horse("h1")], racingHorseIds(null));
    expect(options[0].racesToday).toBe(false);
  });
});

describe("toHorseOptions — naming and byline", () => {
  it("prefers the racing name, which is what members are shown", () => {
    const [o] = toHorseOptions([horse("h1", { racing_name: "MAHOGANY (AUS)" })], new Set());
    expect(o.name).toBe("MAHOGANY (AUS)");
  });

  it("falls back to display_name, then to a placeholder", () => {
    expect(toHorseOptions([horse("h1", { racing_name: null })], new Set())[0].name).toBe("Horse h1");
    expect(
      toHorseOptions([horse("h1", { racing_name: null, display_name: null })], new Set())[0].name,
    ).toBe("Unnamed horse");
  });

  it("reads the trainer through a to-one embed served as a 1-element array", () => {
    const [o] = toHorseOptions(
      [horse("h1", { trainer: [{ id: "t9", name: "Peter Moody", display_name: null }] })],
      new Set(),
    );
    expect(o.trainerName).toBe("Peter Moody");
  });

  it("survives a horse with no trainer at all", () => {
    const [o] = toHorseOptions([horse("h1", { trainer: null, trainer_id: null })], new Set());
    expect(o.trainerId).toBeNull();
    expect(o.trainerName).toBeNull();
  });
});

describe("one", () => {
  it("unwraps PostgREST's object-or-array to-one embed", () => {
    expect(one({ id: "a" })).toEqual({ id: "a" });
    expect(one([{ id: "a" }])).toEqual({ id: "a" });
    expect(one([])).toBeNull();
    expect(one(null)).toBeNull();
  });
});

describe("toTrainerOptions", () => {
  it("maps names with a display_name fallback", () => {
    expect(
      toTrainerOptions([
        { id: "t1", name: "Chris Waller", display_name: null },
        { id: "t2", name: null, display_name: "Peter Moody" },
        { id: "t3", name: null, display_name: null },
      ]),
    ).toEqual([
      { id: "t1", name: "Chris Waller" },
      { id: "t2", name: "Peter Moody" },
      { id: "t3", name: "Unnamed trainer" },
    ]);
  });

  it("is empty for a failed read", () => {
    expect(toTrainerOptions(null)).toEqual([]);
  });
});
