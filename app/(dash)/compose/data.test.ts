// The race-day badge must be DATA-DRIVEN. It was hardcoded on every post
// before ENG-558, and the loader is an async server component, so without
// these tests the regression (`racesToday: true`) sails through the suite.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadPostPhotos,
  loadRacingHorseIds,
  one,
  racingHorseIds,
  toHorseOptions,
  toTrainerOptions,
  type HorseRow,
  type PostMediaClient,
  type PostMediaRow,
  type RaceQueryClient,
  type RaceTodayRow,
} from "./data";
import { trainerSubline } from "./types";

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
        { id: "t1", name: "Chris Waller", display_name: null, stable_name: null, location: null, photo_url: null },
        { id: "t2", name: null, display_name: "Peter Moody", stable_name: null, location: null, photo_url: null },
        { id: "t3", name: null, display_name: null, stable_name: null, location: null, photo_url: null },
      ]),
    ).toEqual([
      { id: "t1", name: "Chris Waller", photoUrl: null, stableName: null, location: null },
      { id: "t2", name: "Peter Moody", photoUrl: null, stableName: null, location: null },
      { id: "t3", name: "Unnamed trainer", photoUrl: null, stableName: null, location: null },
    ]);
  });

  // ENG-1268 — the trainer-profile subline fields, mapped straight through
  // (bare storage path for photoUrl; `page.tsx` signs the whole set later).
  it("maps stable_name/location/photo_url through, unsigned", () => {
    expect(
      toTrainerOptions([
        {
          id: "t1",
          name: "Chris Waller",
          display_name: null,
          stable_name: "Rosehill Stables",
          location: "Rosehill, NSW",
          photo_url: "trainer-photos/t1.jpg",
        },
      ]),
    ).toEqual([
      {
        id: "t1",
        name: "Chris Waller",
        photoUrl: "trainer-photos/t1.jpg",
        stableName: "Rosehill Stables",
        location: "Rosehill, NSW",
      },
    ]);
  });

  it("is empty for a failed read", () => {
    expect(toTrainerOptions(null)).toEqual([]);
  });
});

// ENG-1268 — the trainer-profile subline: `stable · location`, skipping
// whichever half is missing, empty when both are.
describe("trainerSubline", () => {
  it("joins stable and location with a middle dot when both are present", () => {
    expect(trainerSubline({ stableName: "Rosehill Stables", location: "Rosehill, NSW" })).toBe(
      "Rosehill Stables · Rosehill, NSW",
    );
  });

  it("is just the stable name when location is missing", () => {
    expect(trainerSubline({ stableName: "Rosehill Stables", location: null })).toBe(
      "Rosehill Stables",
    );
  });

  it("is just the location when stable name is missing", () => {
    expect(trainerSubline({ stableName: null, location: "Rosehill, NSW" })).toBe("Rosehill, NSW");
  });

  it("is empty when neither is present", () => {
    expect(trainerSubline({ stableName: null, location: null })).toBe("");
  });
});

// ---------------------------------------------------------------------------
// loadRacingHorseIds — the query itself, not just the mapping.
//
// These exist because page.tsx is an async server component and cannot be
// tested. With the read inline there, THREE regressions passed the full suite:
// dropping the race_date filter (every horse that ever raced gets a badge),
// deleting the error branch, and building the set from horse ids. The first two
// are pinned here; the spy records its arguments, because a query mock that
// swallows them cannot see a missing filter (.rx/gotchas.md).
// ---------------------------------------------------------------------------

function spyClient(result: { data: RaceTodayRow[] | null; error: { message: string } | null }) {
  const calls: { table?: string; columns?: string; eq?: [string, string] } = {};
  const client: RaceQueryClient = {
    from(table) {
      calls.table = table;
      return {
        select(columns) {
          calls.columns = columns;
          return {
            eq(column, value) {
              calls.eq = [column, value];
              return Promise.resolve(result);
            },
          };
        },
      };
    },
  };
  return { client, calls };
}

describe("loadRacingHorseIds", () => {
  afterEach(() => vi.restoreAllMocks());

  it("filters races to the given day — without this every past runner is 'racing today'", async () => {
    const { client, calls } = spyClient({
      data: [{ race_horse: [{ horse_id: "h1" }, { horse_id: "h2" }] }],
      error: null,
    });

    const got = await loadRacingHorseIds(client, "2026-08-18");

    expect(calls.table).toBe("race");
    expect(calls.columns).toBe("race_horse(horse_id)");
    // The whole point: a date-scoped equality, on the date it was handed.
    expect(calls.eq).toEqual(["race_date", "2026-08-18"]);
    expect(got.failed).toBe(false);
    expect([...got.ids].sort()).toEqual(["h1", "h2"]);
  });

  it("reports a FAILED read instead of passing it off as 'nobody races today'", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = spyClient({ data: null, error: { message: "permission denied" } });

    const got = await loadRacingHorseIds(client, "2026-08-18");

    // Fails in the safe direction — no badge is shown, never a false one...
    expect(got.ids.size).toBe(0);
    // ...but the caller can still tell the two cases apart.
    expect(got.failed).toBe(true);
    expect(err).toHaveBeenCalledOnce();
    // The message only — no error object, no .details, no .hint.
    expect(err.mock.calls[0][1]).toBe("permission denied");
  });

  it("distinguishes a genuinely empty race day from a failure", async () => {
    const { client } = spyClient({ data: [], error: null });
    const got = await loadRacingHorseIds(client, "2026-08-18");
    expect(got.ids.size).toBe(0);
    expect(got.failed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadPostPhotos — edit mode's post_media read.
//
// Extracted from page.tsx (ENG-1266 review): page.tsx is an async server
// component and cannot be unit-tested, and this read owns the "an errored
// read is not the same fact as zero rows" branch that a regression could
// silently delete there without a single test noticing.
// ---------------------------------------------------------------------------

const POST_ID = "post-1";

function postMediaSpyClient(result: { data: PostMediaRow[] | null; error: { message: string } | null }) {
  const calls: { table?: string; columns?: string; eq?: [string, string]; order?: string } = {};
  const client: PostMediaClient = {
    from(table) {
      calls.table = table;
      return {
        select(columns) {
          calls.columns = columns;
          return {
            eq(column, value) {
              calls.eq = [column, value];
              return {
                order(column2) {
                  calls.order = column2;
                  return Promise.resolve(result);
                },
              };
            },
          };
        },
      };
    },
  };
  return { client, calls };
}

describe("loadPostPhotos", () => {
  it("mediaError → photosUnavailable, empty photos, and the signer is NEVER called", async () => {
    const { client } = postMediaSpyClient({ data: null, error: { message: "permission denied" } });
    const signSet = vi.fn();

    const got = await loadPostPhotos(client, POST_ID, null, signSet);

    expect(got).toEqual({ photos: [], photosUnavailable: true });
    expect(signSet).not.toHaveBeenCalled();
  });

  it("rows present, in sort_order order → signed photos; a path missing from the signed map yields url: null", async () => {
    // The query itself asks Postgres to sort (`.order("sort_order")`,
    // asserted below) — the function trusts that ordering rather than
    // re-sorting client-side, so the spy hands rows back ALREADY in
    // sort_order 0, 1, ... order, exactly as the real query would.
    const { client, calls } = postMediaSpyClient({
      data: [
        { media_url: `${POST_ID}/original`, sort_order: 0 },
        { media_url: `${POST_ID}/photo-1`, sort_order: 1 },
      ],
      error: null,
    });
    const signSet = vi.fn().mockResolvedValue(new Map([[`${POST_ID}/photo-1`, "https://signed/photo-1"]]));

    const got = await loadPostPhotos(client, POST_ID, null, signSet);

    expect(calls.table).toBe("post_media");
    expect(calls.columns).toBe("media_url,sort_order");
    expect(calls.eq).toEqual(["post_id", POST_ID]);
    expect(calls.order).toBe("sort_order");
    // The signer got the paths in sort_order order.
    expect(signSet).toHaveBeenCalledWith([`${POST_ID}/original`, `${POST_ID}/photo-1`]);
    expect(got).toEqual({
      photos: [
        { path: `${POST_ID}/original`, url: null }, // missing from the signed map
        { path: `${POST_ID}/photo-1`, url: "https://signed/photo-1" },
      ],
      photosUnavailable: false,
    });
  });

  it("no rows but a legacy post.media_url → a ONE-entry synthesised set", async () => {
    const { client } = postMediaSpyClient({ data: [], error: null });
    const signSet = vi.fn().mockResolvedValue(new Map([[`${POST_ID}/original`, "https://signed/original"]]));

    const got = await loadPostPhotos(client, POST_ID, `${POST_ID}/original`, signSet);

    expect(signSet).toHaveBeenCalledWith([`${POST_ID}/original`]);
    expect(got).toEqual({
      photos: [{ path: `${POST_ID}/original`, url: "https://signed/original" }],
      photosUnavailable: false,
    });
  });

  it("a row path that does not start with `<postId>/` → photosUnavailable, empty photos, signer never called", async () => {
    const { client } = postMediaSpyClient({
      data: [{ media_url: "https://old-cdn.example/absolute.jpg", sort_order: 0 }],
      error: null,
    });
    const signSet = vi.fn();

    const got = await loadPostPhotos(client, POST_ID, null, signSet);

    expect(got).toEqual({ photos: [], photosUnavailable: true });
    expect(signSet).not.toHaveBeenCalled();
  });

  it("a legacy media_url mirror that does not start with `<postId>/` → same prefix-mismatch degrade", async () => {
    const { client } = postMediaSpyClient({ data: [], error: null });
    const signSet = vi.fn();

    const got = await loadPostPhotos(client, POST_ID, "https://old-cdn.example/absolute.jpg", signSet);

    expect(got).toEqual({ photos: [], photosUnavailable: true });
    expect(signSet).not.toHaveBeenCalled();
  });

  it("genuinely empty (no rows, no media_url) → photos: [], photosUnavailable: false — DECIDED behaviour", async () => {
    // No rows and no legacy mirror is a real, valid state: the strip is
    // empty. `editPhotoEmpty` in ComposeScreen then hard-disables Save /
    // Publish / Schedule, and the operator's only way forward is "Add more
    // photos" — that is deliberate, not a bug to route around here. A photo
    // post must have a photo, so this function reports the plain fact and
    // lets the screen own refusing to save it.
    const { client } = postMediaSpyClient({ data: [], error: null });
    // The prefix check passes vacuously on an empty set, so the function
    // still calls through to the signer with `[]` — it is `signPhotoMap`'s
    // own job (and is already covered by its own tests) to treat an empty
    // path list as a no-op rather than a Storage round-trip.
    const signSet = vi.fn().mockResolvedValue(new Map());

    const got = await loadPostPhotos(client, POST_ID, null, signSet);

    expect(got).toEqual({ photos: [], photosUnavailable: false });
    expect(signSet).toHaveBeenCalledWith([]);
  });

  it("data: null with error: null is NOT an errored read — it falls through to the legacy mirror", async () => {
    // PostgREST can hand back `{ data: null, error: null }`, which the code
    // absorbs with `mediaRows ?? []`. Pinned because that `??` is otherwise
    // vacuous in the tests above, and because the distinction is the whole
    // point of this function: only `error !== null` may set
    // `photosUnavailable`. A null body with no error is "no rows", so the
    // legacy mirror still has to be synthesised rather than the post
    // degrading to media-read-only.
    const { client } = postMediaSpyClient({ data: null, error: null });
    const signSet = vi.fn().mockResolvedValue(new Map([[`${POST_ID}/original`, "https://signed/original"]]));

    const got = await loadPostPhotos(client, POST_ID, `${POST_ID}/original`, signSet);

    expect(got).toEqual({
      photos: [{ path: `${POST_ID}/original`, url: "https://signed/original" }],
      photosUnavailable: false,
    });
  });
});
