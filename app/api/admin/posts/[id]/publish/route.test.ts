import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));

import { POST } from "./route";

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}
function asNonAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: false } } };
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("POST /api/admin/posts/:id/publish", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await POST(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(403);
  });

  it("publishes a draft → 200 published + fans out new_post via push-dispatch", async () => {
    asAdmin();
    state.tables.post = {
      select: { single: { id: "p1", horse_id: "h1", status: "draft", title: "T", body: "B" } },
      mutate: { single: { id: "p1", status: "published", published_at: "2026-07-11T00:00:00.000Z" } },
    };
    state.functions = { "push-dispatch": { data: { notificationsSent: 3 } } };

    const r = await POST(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.status).toBe("published");
    expect(j.data.notificationsSent).toBe(3);

    const call = state.calls.functions.find((c) => c.name === "push-dispatch");
    expect(call).toBeTruthy();
    expect(call!.body.type).toBe("new_post");
    expect(call!.body.horseId).toBe("h1");
    expect(call!.body.targetType).toBe("post");
    expect(call!.body.targetId).toBe("p1");
  });

  it("409 invalid_status when the post is already published", async () => {
    asAdmin();
    state.tables.post = { select: { single: { id: "p1", horse_id: "h1", status: "published" } } };
    const r = await POST(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error.code).toBe("invalid_status");
  });

  it("404 when the post is missing", async () => {
    asAdmin();
    state.tables.post = { select: { single: null } };
    const r = await POST(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(404);
  });
});
