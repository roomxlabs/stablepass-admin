import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";
import {
  listTrainers,
  initials,
  timeAgo,
  toTrainerFormSeed,
  TRAINER_DETAIL_COLUMNS,
  TRAINER_DETAIL_COLUMN_MAP,
  type TrainerDetailRow,
  trainerHorsesHref,
} from "./data";

// listTrainers takes the sb client by injection, so no module mock is needed —
// we drive results per table through the shared Supabase fake.
const state: FakeState = blankState();
const sb = () => makeFakeClient(state) as unknown as SupabaseClient;

function seed() {
  state.tables.trainer = {
    select: {
      rows: [
        { id: "t1", name: "Chris Waller", display_name: "Chris Waller", slug: "chris-waller", stable_name: "Chris Waller Racing", location: "Rosehill, NSW", status: "active", photo_url: null, marketing_visible: true },
        { id: "t2", name: "John Thompson", display_name: "John Thompson", slug: "john-thompson", stable_name: "Thompson Stables", location: "Warwick Farm, NSW", status: "onboarding", photo_url: null, marketing_visible: false },
      ],
    },
  };
  state.tables.horse = { select: { rows: [{ trainer_id: "t1" }, { trainer_id: "t1" }, { trainer_id: "t2" }] } };
  state.tables.post = { select: { rows: [{ source_trainer_id: "t1", published_at: "2026-07-11T00:00:00Z", created_at: "2026-07-10T00:00:00Z" }] } };
  state.tables.trainer_contact = { select: { rows: [{ trainer_id: "t1", role: "Trainer", email: "chris@waller.au" }] } };
}

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("listTrainers", () => {
  it("shapes rows with horse count, last post, contact email + roster counts", async () => {
    seed();
    const { rows, counts } = await listTrainers(sb(), {});
    expect(rows).toHaveLength(2);
    const t1 = rows.find((r) => r.id === "t1")!;
    expect(t1.horseCount).toBe(2);
    expect(t1.contactEmail).toBe("chris@waller.au");
    expect(t1.lastPostAt).toBe("2026-07-11T00:00:00Z");
    const t2 = rows.find((r) => r.id === "t2")!;
    expect(t2.horseCount).toBe(1);
    expect(t2.lastPostAt).toBeNull();
    expect(counts).toEqual({ all: 2, active: 1, onboarding: 1 });
  });

  // ENG-766: this mapping is what the list's "On site" badge renders from, so it
  // is asserted directly rather than left to a fixture-shaped `toMatchObject`.
  it("maps marketing_visible onto the row, per trainer", async () => {
    seed();
    const { rows } = await listTrainers(sb(), {});
    expect(rows.find((r) => r.id === "t1")!.marketingVisible).toBe(true);
    expect(rows.find((r) => r.id === "t2")!.marketingVisible).toBe(false);
  });

  it("fails closed: a row with no marketing_visible is NOT badged as published", async () => {
    state.tables.trainer = {
      select: { rows: [{ id: "t9", name: "Ghost", display_name: "Ghost", slug: "ghost", status: "active" }] },
    };
    const { rows } = await listTrainers(sb(), {});
    expect(rows[0].marketingVisible).toBe(false);
  });

  it("?q= applies an ILIKE over name/display_name/stable/location", async () => {
    seed();
    await listTrainers(sb(), { q: "waller" });
    const orExpr = state.calls.or.join(" | ");
    expect(orExpr).toContain("name.ilike.%waller%");
    expect(orExpr).toContain("stable_name.ilike.%waller%");
    expect(orExpr).toContain("location.ilike.%waller%");
  });

  it("strips PostgREST structural chars from the search term", async () => {
    seed();
    await listTrainers(sb(), { q: "a,(b)" });
    const orExpr = state.calls.or.join(" | ");
    expect(orExpr).not.toContain("(");
    expect(orExpr).not.toContain(")");
  });
});

// ENG-766. This mapping seeds the edit form, and one field of it is a safety
// control: if `marketing_photo_path` does not reach the form, the form believes
// nothing is published, and taking the trainer off the site then leaves a live
// object in a PUBLIC bucket. It had no coverage at all until this was extracted
// out of the Server Component.
describe("toTrainerFormSeed", () => {
  const row: TrainerDetailRow = {
    id: "t1",
    name: "Chris Waller",
    display_name: "Chris Waller",
    stable_name: "Chris Waller Racing",
    location: "Rosehill, NSW",
    bio: "Leading Sydney trainer.",
    photo_url: "chris-waller-172.jpg",
    status: "active",
    marketing_visible: true,
    marketing_photo_path: "trainers/t1.jpg",
    website_url: "https://wallerracing.com.au",
  };

  // ENG-746. The edit page CASTS its result to TrainerDetailRow, and a cast
  // cannot check a runtime projection: drop a column from the select string and
  // the field arrives undefined, coalesces to null, and the form silently blanks
  // a saved value on the next save. tsc keeps the map complete against the type;
  // this keeps the select string equal to the map. Without both halves the chain
  // has a hole at exactly the point that is hardest to notice.
  it("selects every column the detail row declares, and no others", () => {
    expect(TRAINER_DETAIL_COLUMNS.split(",").sort()).toEqual(Object.keys(TRAINER_DETAIL_COLUMN_MAP).sort());
  });

  it("selects website_url (the column the whole ticket exists to populate)", () => {
    expect(TRAINER_DETAIL_COLUMNS.split(",")).toContain("website_url");
  });

  // ENG-746 mutation guard: `supabaseServer()` has no Database generic, so the
  // edit page's `t as TrainerDetailRow` cast typechecks against ANY select
  // string, including a hand-written literal that drops a column. A cast
  // cannot check a runtime projection, so reading the page's source text is
  // the only link in the type -> map -> string -> page chain that the
  // compiler cannot guard for us.
  it("edit page selects via the shared TRAINER_DETAIL_COLUMNS constant, not a hand-written literal", () => {
    const src = readFileSync(new URL("./[id]/edit/page.tsx", import.meta.url), "utf8");
    expect(src).toContain(".select(TRAINER_DETAIL_COLUMNS)");
    expect(src).not.toMatch(/\.select\("id,name/);
  });

  it("seeds the website so an unrelated edit cannot blank it", () => {
    expect(toTrainerFormSeed(row).websiteUrl).toBe("https://wallerracing.com.au");
  });

  it("seeds a missing website as null rather than undefined", () => {
    expect(toTrainerFormSeed({ ...row, website_url: null }).websiteUrl).toBeNull();
  });

  it("seeds a dropped website column (undefined, not an explicit null) as null", () => {
    // Simulates a select that silently dropped website_url: the field then
    // arrives `undefined` off the wire rather than an explicit `null`. The
    // cast to TrainerDetailRow cannot catch that at compile time, so `?? null`
    // in toTrainerFormSeed is the only thing standing between a dropped column
    // and `websiteUrl: undefined` reaching the form. The cast below is
    // deliberately lying about the shape, to simulate exactly that dropped
    // column.
    const droppedColumn = { ...row, website_url: undefined } as unknown as TrainerDetailRow;
    expect(toTrainerFormSeed(droppedColumn).websiteUrl).toBeNull();
  });

  it("seeds a dropped marketing photo path (undefined) as null, the same way", () => {
    // marketing_photo_path carries the same `?? null` shape and the same
    // safety property (see the module comment in data.ts): if it seeds as
    // undefined the form believes nothing is published, and un-publishing
    // then leaves a live object in a PUBLIC bucket. One case here, not a full
    // sweep of every seeded field.
    const droppedColumn = { ...row, marketing_photo_path: undefined } as unknown as TrainerDetailRow;
    expect(toTrainerFormSeed(droppedColumn).marketingPhotoPath).toBeNull();
  });

  it("seeds the marketing flag and the published photo path", () => {
    const seed = toTrainerFormSeed(row);
    expect(seed.marketingVisible).toBe(true);
    expect(seed.marketingPhotoPath).toBe("trainers/t1.jpg");
  });

  it("fails closed on a row that carries neither marketing column", () => {
    const seed = toTrainerFormSeed({ ...row, marketing_visible: null, marketing_photo_path: null });
    expect(seed.marketingVisible).toBe(false);
    expect(seed.marketingPhotoPath).toBeNull();
  });

  it("maps the rest of the profile, coercing nulls to empty strings", () => {
    const seed = toTrainerFormSeed({
      ...row,
      display_name: null,
      stable_name: null,
      location: null,
      bio: null,
      photo_url: null,
      status: "onboarding",
    });
    expect(seed).toMatchObject({
      displayName: "",
      stableName: "",
      location: "",
      bio: "",
      photoUrl: null,
      status: "onboarding",
    });
  });
});

describe("helpers", () => {
  it("initials derives 1–2 letter monograms", () => {
    expect(initials("Chris Waller")).toBe("CW");
    expect(initials("Godolphin")).toBe("GO");
    expect(initials("Anthony & Sam Cummings")).toBe("AC");
  });

  it("timeAgo formats recency, '-' for null", () => {
    const now = new Date("2026-07-11T12:00:00Z");
    expect(timeAgo(null, now)).toBe("-");
    expect(timeAgo("2026-07-11T10:00:00Z", now)).toBe("2h ago");
    expect(timeAgo("2026-07-10T12:00:00Z", now)).toBe("Yesterday");
  });
});

// Justin, 2 Sep 2026: the "N horses" cell opens that trainer's horses.
describe("trainerHorsesHref", () => {
  it("links a trainer with horses to the trainer-scoped horses list", () => {
    expect(trainerHorsesHref("t1", 4)).toBe("/horses?trainerId=t1");
  });

  it("is null for a trainer with no horses — an empty scoped list is a dead end", () => {
    expect(trainerHorsesHref("t1", 0)).toBeNull();
  });
});
