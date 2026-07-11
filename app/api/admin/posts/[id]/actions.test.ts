import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));

import { POST as schedule } from "./schedule/route";
import { POST as unpublish } from "./unpublish/route";
import { POST as republish } from "./republish/route";
import { GET as preview } from "./preview/route";

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}
function asNonAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: false } } };
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const bodyReq = (body: unknown) => new Request("http://t", { method: "POST", body: JSON.stringify(body) });
const future = () => new Date(Date.now() + 86_400_000).toISOString();
const past = () => new Date(Date.now() - 86_400_000).toISOString();

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("POST /api/admin/posts/:id/schedule", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await schedule(bodyReq({ scheduledFor: future() }), ctx("p1"));
    expect(r.status).toBe(403);
  });

  it("schedules a draft → 200 scheduled", async () => {
    asAdmin();
    const when = future();
    state.tables.post = {
      select: { single: { status: "draft" } },
      mutate: { single: { id: "p1", status: "scheduled", scheduled_for: when } },
    };
    const r = await schedule(bodyReq({ scheduledFor: when }), ctx("p1"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.status).toBe("scheduled");
  });

  it("400 scheduled_for_in_past for a past time", async () => {
    asAdmin();
    const r = await schedule(bodyReq({ scheduledFor: past() }), ctx("p1"));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("scheduled_for_in_past");
  });

  it("409 invalid_status when the post is already published", async () => {
    asAdmin();
    state.tables.post = { select: { single: { status: "published" } } };
    const r = await schedule(bodyReq({ scheduledFor: future() }), ctx("p1"));
    expect(r.status).toBe(409);
  });
});

describe("POST /api/admin/posts/:id/unpublish", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await unpublish(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(403);
  });

  it("soft-hides a published post → 200 unpublished", async () => {
    asAdmin();
    state.tables.post = {
      select: { single: { status: "published" } },
      mutate: { single: { id: "p1", status: "unpublished" } },
    };
    const r = await unpublish(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.status).toBe("unpublished");
  });

  it("409 when the post is not published", async () => {
    asAdmin();
    state.tables.post = { select: { single: { status: "draft" } } };
    const r = await unpublish(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(409);
  });
});

describe("POST /api/admin/posts/:id/republish", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await republish(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(403);
  });

  it("restores an unpublished post → 200 published", async () => {
    asAdmin();
    state.tables.post = {
      select: { single: { status: "unpublished" } },
      mutate: { single: { id: "p1", status: "published" } },
    };
    const r = await republish(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.status).toBe("published");
  });

  it("409 when the post is not unpublished", async () => {
    asAdmin();
    state.tables.post = { select: { single: { status: "published" } } };
    const r = await republish(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(409);
  });
});

describe("GET /api/admin/posts/:id/preview", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await preview(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(403);
  });

  it("returns mobile + web frames for an admin", async () => {
    asAdmin();
    state.tables.post = {
      select: {
        single: {
          id: "p1",
          type: "photo",
          status: "draft",
          title: "T",
          body: "B",
          media_url: "p1/original",
          horse: { display_name: "Sire x Dam", racing_name: "Fast Horse" },
          trainer: { name: "C. Waller" },
        },
      },
    };
    const r = await preview(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.mobile.horseName).toBe("Fast Horse");
    expect(j.data.web.byline).toBe("C. Waller");
  });

  it("404 when the post is missing", async () => {
    asAdmin();
    state.tables.post = { select: { single: null } };
    const r = await preview(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(404);
  });
});
