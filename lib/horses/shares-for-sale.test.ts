import { describe, it, expect, beforeEach } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";
import { recordCalls, blankRecord, type CallRecord } from "@/lib/testing/call-recorder";
import {
  parseSharesForSale,
  rejectSharesWithoutTrainerWebsite,
  SHARES_WEBSITE_REQUIRED,
  trainerIdForHorse,
} from "./shares-for-sale";

const state: FakeState = blankState();
const rec: CallRecord = blankRecord();
const sb = () => recordCalls(makeFakeClient(state), rec);

beforeEach(() => {
  Object.assign(state, blankState());
  Object.assign(rec, blankRecord());
});

describe("parseSharesForSale", () => {
  it("treats absence as undefined (caller leaves / defaults)", () => {
    expect(parseSharesForSale(undefined)).toEqual({ ok: true, value: undefined });
  });

  it("accepts true and false", () => {
    expect(parseSharesForSale(true)).toEqual({ ok: true, value: true });
    expect(parseSharesForSale(false)).toEqual({ ok: true, value: false });
  });

  it("rejects a non-boolean", () => {
    expect(parseSharesForSale("yes").ok).toBe(false);
    expect(parseSharesForSale(1).ok).toBe(false);
  });
});

describe("rejectSharesWithoutTrainerWebsite", () => {
  it("returns null when the trainer has a website", async () => {
    state.tables.trainer = {
      select: { single: { id: "t1", website_url: "https://wallerracing.com.au" } },
    };
    await expect(rejectSharesWithoutTrainerWebsite(sb(), "t1")).resolves.toBeNull();
    expect(rec.filters).toContain("trainer.id=t1");
  });

  it("400s with the form copy when website_url is null", async () => {
    state.tables.trainer = { select: { single: { id: "t1", website_url: null } } };
    const res = await rejectSharesWithoutTrainerWebsite(sb(), "t1");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const j = await res!.json();
    expect(j.error.code).toBe("validation_failed");
    expect(j.error.message).toBe(SHARES_WEBSITE_REQUIRED);
  });

  it("400s when the trainer row is missing", async () => {
    state.tables.trainer = { select: { single: null } };
    const res = await rejectSharesWithoutTrainerWebsite(sb(), "missing");
    expect(res!.status).toBe(400);
    expect((await res!.json()).error.code).toBe("validation_failed");
  });
});

describe("trainerIdForHorse", () => {
  it("returns the horse's trainer_id", async () => {
    state.tables.horse = { select: { single: { id: "h1", trainer_id: "t1" } } };
    await expect(trainerIdForHorse(sb(), "h1")).resolves.toEqual({ ok: true, trainerId: "t1" });
    expect(rec.filters).toContain("horse.id=h1");
  });

  it("404s when the horse is missing", async () => {
    state.tables.horse = { select: { single: null } };
    const r = await trainerIdForHorse(sb(), "nope");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.res.status).toBe(404);
  });
});
