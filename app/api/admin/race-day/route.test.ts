import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";
import { parseWindowHours } from "@/lib/dashboard/queries";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));

import { GET } from "./route";

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 864e5).toISOString();
const inHours = (h: number) => new Date(Date.now() + h * 36e5).toISOString();

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}
function asNonAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: false } } };
}
function req(qs = ""): Request {
  return new Request(`http://t/api/admin/race-day${qs}`);
}

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("parseWindowHours", () => {
  it("defaults to 24h", () => {
    expect(parseWindowHours(null)).toBe(24);
    expect(parseWindowHours("")).toBe(24);
    expect(parseWindowHours("garbage")).toBe(24);
  });
  it("parses an hour value with or without the 'h' suffix", () => {
    expect(parseWindowHours("24h")).toBe(24);
    expect(parseWindowHours("48h")).toBe(48);
    expect(parseWindowHours("6")).toBe(6);
  });
  it("caps at 7 days (168h)", () => {
    expect(parseWindowHours("999h")).toBe(168);
  });
});

describe("GET /api/admin/race-day", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await GET(req());
    expect(r.status).toBe(403);
  });

  it("returns upcoming races within the window, runners annotated with post recency", async () => {
    asAdmin();
    state.tables.race = {
      select: {
        rows: [
          {
            id: "r1",
            venue: "Caulfield",
            race_number: 3,
            race_class: "Maiden",
            scheduled_at: inHours(2),
            race_horse: [
              {
                horse_id: "h4",
                horse: {
                  display_name: "Northern Star",
                  racing_name: null,
                  trainer: { name: "Peter Moody", display_name: "Peter Moody" },
                },
              },
            ],
          },
          {
            id: "r2",
            venue: "Rosehill",
            race_number: 7,
            race_class: "G2",
            scheduled_at: inHours(6),
            race_horse: [
              {
                horse_id: "h2",
                horse: {
                  display_name: "Verry Elleegant",
                  racing_name: "VERRY ELLEEGANT (NZ)",
                  trainer: { name: "Chris Waller", display_name: "Chris Waller" },
                },
              },
            ],
          },
        ],
      },
    };
    // Only h4 has a published post → hasPost true; h2 has none → hasPost false.
    state.tables.post = { select: { rows: [{ horse_id: "h4", published_at: iso(2) }] } };

    const r = await GET(req("?window=24h"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.meta.window).toBe("24h");
    expect(j.data).toHaveLength(2);

    const r1 = j.data[0];
    expect(r1.venue).toBe("Caulfield");
    expect(r1.raceNumber).toBe(3);
    expect(r1.runners).toHaveLength(1);
    expect(r1.runners[0].name).toBe("Northern Star"); // falls back to display_name
    expect(r1.runners[0].trainer).toBe("Peter Moody");
    expect(r1.runners[0].hasPost).toBe(true);
    expect(r1.runners[0].lastPostAt).not.toBeNull();

    const r2 = j.data[1];
    expect(r2.runners[0].name).toBe("VERRY ELLEEGANT (NZ)");
    expect(r2.runners[0].hasPost).toBe(false);
    expect(r2.runners[0].lastPostAt).toBeNull();
  });

  it("returns an empty list when nothing is racing", async () => {
    asAdmin();
    const r = await GET(req());
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data).toEqual([]);
  });
});
