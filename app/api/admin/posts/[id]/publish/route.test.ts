import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

// The shared fake's `functions.invoke` only records `{name, body}` and never
// throws — it has no notion of headers or of a rejected/errored invoke. Both
// are needed here (asserting the `x-dispatch-secret` header, and simulating a
// push-dispatch failure without un-publishing the post), so this file wraps
// the fake client's `functions.invoke` locally rather than extending the
// shared `lib/testing/supabase-fake.ts` harness used by every other route's
// tests.
let invokeCalls: { name: string; body: unknown; headers: unknown }[] = [];
let invokeOverride:
  | ((name: string, opts?: { body?: unknown; headers?: unknown }) => Promise<{ data?: unknown; error?: unknown }>)
  | null = null;

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => {
    const client = makeFakeClient(state);
    const originalInvoke = client.functions.invoke.bind(client.functions);
    client.functions.invoke = async (name: string, opts?: { body?: unknown; headers?: unknown }) => {
      invokeCalls.push({ name, body: opts?.body, headers: opts?.headers });
      if (invokeOverride) return invokeOverride(name, opts);
      return originalInvoke(name, opts);
    };
    return client;
  },
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

const ORIGINAL_SECRET = process.env.PUSH_DISPATCH_SECRET;

beforeEach(() => {
  Object.assign(state, blankState());
  invokeCalls = [];
  invokeOverride = null;
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.PUSH_DISPATCH_SECRET;
  else process.env.PUSH_DISPATCH_SECRET = ORIGINAL_SECRET;
});

describe("POST /api/admin/posts/:id/publish", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await POST(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(403);
  });

  it("publishes a draft → 200 published + fans out new_post via push-dispatch", async () => {
    asAdmin();
    process.env.PUSH_DISPATCH_SECRET = "test-secret";
    state.tables.post = {
      select: { single: { id: "p1", horse_id: "h1", status: "draft", title: "T", body: "B", published_at: null } },
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

  it("dispatches once with the right payload + secret", async () => {
    asAdmin();
    process.env.PUSH_DISPATCH_SECRET = "test-secret";
    state.tables.post = {
      select: { single: { id: "p1", horse_id: "h1", status: "draft", title: "T", body: "B", published_at: null } },
      mutate: { single: { id: "p1", status: "published", published_at: "2026-07-11T00:00:00.000Z" } },
    };
    state.functions = { "push-dispatch": { data: { notificationsSent: 3 } } };

    const r = await POST(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(200);

    expect(invokeCalls).toHaveLength(1);
    expect(invokeCalls[0].name).toBe("push-dispatch");
    expect(invokeCalls[0].body).toEqual({
      type: "new_post",
      horseId: "h1",
      targetType: "post",
      targetId: "p1",
      title: "T",
      body: "B",
    });
    expect(invokeCalls[0].headers).toEqual({ "x-dispatch-secret": "test-secret" });
  });

  it("a post with a non-null published_at does not re-dispatch (defence-in-depth)", async () => {
    asAdmin();
    process.env.PUSH_DISPATCH_SECRET = "test-secret";
    state.tables.post = {
      select: {
        single: {
          id: "p1",
          horse_id: "h1",
          status: "draft",
          title: "T",
          body: "B",
          published_at: "2026-01-01T00:00:00.000Z",
        },
      },
      mutate: { single: { id: "p1", status: "published", published_at: "2026-07-11T00:00:00.000Z" } },
    };

    const r = await POST(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.status).toBe("published");
    expect(j.data.notificationsSent).toBe(0);
    expect(invokeCalls).toHaveLength(0);
  });

  it("concurrent publish/cron race: the update affects 0 rows → 409, no dispatch", async () => {
    asAdmin();
    process.env.PUSH_DISPATCH_SECRET = "test-secret";
    state.tables.post = {
      select: {
        single: { id: "p1", horse_id: "h1", status: "scheduled", title: "T", body: "B", published_at: null },
      },
      // Simulates a concurrent request (another admin double-click, or the be
      // scheduled-post-publisher cron) already flipping this row's status
      // between our read and our write: the `.in("status", ...)`-scoped
      // update matches 0 rows.
      mutate: { single: null },
    };

    const r = await POST(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error.code).toBe("invalid_status");
    expect(invokeCalls).toHaveLength(0);
  });

  it("caption-less post (null title/body) still notifies with generic fallback text", async () => {
    asAdmin();
    process.env.PUSH_DISPATCH_SECRET = "test-secret";
    state.tables.post = {
      select: {
        single: { id: "p1", horse_id: "h1", status: "draft", title: null, body: null, published_at: null },
      },
      mutate: { single: { id: "p1", status: "published", published_at: "2026-07-11T00:00:00.000Z" } },
    };
    state.functions = { "push-dispatch": { data: { notificationsSent: 3 } } };

    const r = await POST(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(200);
    expect(invokeCalls[0].body).toEqual({
      type: "new_post",
      horseId: "h1",
      targetType: "post",
      targetId: "p1",
      title: "New post",
      body: "A new update is available.",
    });
  });

  it("body falls back to title when body is null", async () => {
    asAdmin();
    process.env.PUSH_DISPATCH_SECRET = "test-secret";
    state.tables.post = {
      select: {
        single: { id: "p1", horse_id: "h1", status: "draft", title: "T", body: null, published_at: null },
      },
      mutate: { single: { id: "p1", status: "published", published_at: "2026-07-11T00:00:00.000Z" } },
    };
    state.functions = { "push-dispatch": { data: { notificationsSent: 3 } } };

    const r = await POST(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(200);
    expect(invokeCalls[0].body).toEqual({
      type: "new_post",
      horseId: "h1",
      targetType: "post",
      targetId: "p1",
      title: "T",
      body: "T",
    });
  });

  it("dispatch failure (thrown) does not 500 the publish", async () => {
    asAdmin();
    process.env.PUSH_DISPATCH_SECRET = "test-secret";
    state.tables.post = {
      select: { single: { id: "p1", horse_id: "h1", status: "draft", title: "T", body: "B", published_at: null } },
      mutate: { single: { id: "p1", status: "published", published_at: "2026-07-11T00:00:00.000Z" } },
    };
    invokeOverride = async () => {
      throw new Error("boom");
    };

    const r = await POST(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.status).toBe("published");
    expect(j.data.notificationsSent).toBe(0);
  });

  it("dispatch failure (unauthorized error shape) does not 500 the publish", async () => {
    asAdmin();
    // No secret configured server-side would produce this be response shape too,
    // but here we simulate the be's 401 explicitly via the resolved error.
    process.env.PUSH_DISPATCH_SECRET = "test-secret";
    state.tables.post = {
      select: { single: { id: "p1", horse_id: "h1", status: "draft", title: "T", body: "B", published_at: null } },
      mutate: { single: { id: "p1", status: "published", published_at: "2026-07-11T00:00:00.000Z" } },
    };
    invokeOverride = async () => ({ data: null, error: { message: "unauthorized" } });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const r = await POST(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.status).toBe("published");
    expect(j.data.notificationsSent).toBe(0);
    // Pins the `if (error)` branch in `dispatchNewPost` itself — `(null)?.notificationsSent
    // ?? 0` would ALSO yield 0 if that branch were deleted entirely, which is
    // the branch that will handle be #68's new 401.
    expect(spy).toHaveBeenCalledWith("push-dispatch new_post failed", { message: "unauthorized" });
    spy.mockRestore();
  });

  it("no secret configured → does not call push-dispatch, publish still succeeds", async () => {
    asAdmin();
    delete process.env.PUSH_DISPATCH_SECRET;
    state.tables.post = {
      select: { single: { id: "p1", horse_id: "h1", status: "draft", title: "T", body: "B", published_at: null } },
      mutate: { single: { id: "p1", status: "published", published_at: "2026-07-11T00:00:00.000Z" } },
    };

    const r = await POST(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.status).toBe("published");
    expect(j.data.notificationsSent).toBe(0);
    expect(invokeCalls).toHaveLength(0);
  });
});
