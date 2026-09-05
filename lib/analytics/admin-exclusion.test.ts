import { describe, it, expect, beforeEach } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";
import { getAdminUserIds, excludeAdminRows, memberRows } from "./admin-exclusion";

const state: FakeState = blankState();

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("excludeAdminRows", () => {
  it("drops rows produced by an operator", () => {
    const adminIds = new Set(["admin-1"]);
    const rows = [{ user_id: "admin-1" }, { user_id: "member-1" }];
    expect(excludeAdminRows(rows, adminIds)).toEqual([{ user_id: "member-1" }]);
  });

  it("keeps rows with a null user_id (cannot be attributed to an admin)", () => {
    const adminIds = new Set(["admin-1"]);
    const rows = [{ user_id: null }, { user_id: "admin-1" }, { user_id: "member-1" }];
    expect(excludeAdminRows(rows, adminIds)).toEqual([{ user_id: null }, { user_id: "member-1" }]);
  });
});

describe("memberRows", () => {
  it("throws when columns omits user_id", async () => {
    const sb = makeFakeClient(state) as unknown as Parameters<typeof memberRows>[0];
    await expect(memberRows(sb, "impression", "seen_at")).rejects.toThrow(/user_id/);
  });

  it("excludes admin rows given an explicit adminIds set", async () => {
    state.tables.impression = {
      select: {
        rows: [
          { user_id: "admin-1", seen_at: "2026-07-01T00:00:00.000Z" },
          { user_id: "member-1", seen_at: "2026-07-02T00:00:00.000Z" },
        ],
      },
    };
    const sb = makeFakeClient(state) as unknown as Parameters<typeof memberRows>[0];
    const rows = await memberRows(sb, "impression", "user_id,seen_at", undefined, new Set(["admin-1"]));
    expect(rows).toEqual([{ user_id: "member-1", seen_at: "2026-07-02T00:00:00.000Z" }]);
  });
});

describe("getAdminUserIds", () => {
  it("throws on a query error", async () => {
    state.tables.app_user = { select: { error: { message: "connection reset" } } };
    const sb = makeFakeClient(state) as unknown as Parameters<typeof getAdminUserIds>[0];
    await expect(getAdminUserIds(sb)).rejects.toThrow(/admin exclusion/);
  });

  it("returns the set of admin app_user ids", async () => {
    state.tables.app_user = { select: { rows: [{ id: "admin-1" }, { id: "admin-2" }] } };
    const sb = makeFakeClient(state) as unknown as Parameters<typeof getAdminUserIds>[0];
    const ids = await getAdminUserIds(sb);
    expect(ids).toEqual(new Set(["admin-1", "admin-2"]));
  });
});
