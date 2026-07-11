import { describe, it, expect, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";
import { listTrainers, initials, timeAgo } from "./data";

// listTrainers takes the sb client by injection, so no module mock is needed —
// we drive results per table through the shared Supabase fake.
const state: FakeState = blankState();
const sb = () => makeFakeClient(state) as unknown as SupabaseClient;

function seed() {
  state.tables.trainer = {
    select: {
      rows: [
        { id: "t1", name: "Chris Waller", display_name: "Chris Waller", slug: "chris-waller", stable_name: "Chris Waller Racing", location: "Rosehill, NSW", status: "active", photo_url: null },
        { id: "t2", name: "John Thompson", display_name: "John Thompson", slug: "john-thompson", stable_name: "Thompson Stables", location: "Warwick Farm, NSW", status: "onboarding", photo_url: null },
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
