// Retired-exclusion assertion for GET /api/admin/post-labels (ENG-1267),
// split into its own file so its `vi.mock` — wrapped in the call recorder —
// does not replace the plain mock `route.test.ts` already relies on for its
// pre-existing assertions.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";
import { recordCalls, blankRecord, type CallRecord } from "@/lib/testing/call-recorder";

const state: FakeState = blankState();
let rec: CallRecord = blankRecord();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => recordCalls(makeFakeClient(state), rec),
}));

import { GET } from "./route";

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}

beforeEach(() => {
  Object.assign(state, blankState());
  rec = blankRecord();
});

describe("GET /api/admin/post-labels — retired exclusion", () => {
  it("reads with .is(retired_at, null) so retired labels are excluded from the picker", async () => {
    asAdmin();
    state.tables.post_label = {
      select: { rows: [{ id: "l-1", name: "Trackwork", is_builtin: true, sort_order: 1 }] },
    };
    await GET();
    expect(rec.filters).toContain("post_label.retired_at is null");
  });
});
