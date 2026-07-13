import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));
const createMuxDirectUpload = vi.fn<
  (opts?: { passthrough?: string }) => Promise<{ uploadId: string; uploadUrl: string }>
>(async () => ({ uploadId: "up_123", uploadUrl: "https://mux.local/upload" }));
vi.mock("@/lib/mux", () => ({
  MuxError: class MuxError extends Error {},
  createMuxDirectUpload: (opts?: { passthrough?: string }) => createMuxDirectUpload(opts),
}));

import { GET, POST } from "./route";

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}
function asNonAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: false } } };
}
function postReq(body: unknown): Request {
  return new Request("http://t/api/admin/posts", { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("POST /api/admin/posts — create draft", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await POST(postReq({ horseId: "h1", type: "photo", sourceTrainerId: "t1" }));
    expect(r.status).toBe(403);
  });

  it("creates a photo draft → 202 + Storage upload target", async () => {
    asAdmin();
    state.tables.horse = { select: { single: { id: "h1" } } };
    state.tables.post = { mutate: { single: { id: "p1", status: "draft", type: "photo", horse_id: "h1" } } };
    const r = await POST(postReq({ horseId: "h1", type: "photo", sourceTrainerId: "t1", title: "Win" }));
    expect(r.status).toBe(202);
    const j = await r.json();
    expect(j.data.id).toBe("p1");
    expect(j.data.status).toBe("draft");
    expect(j.data.watermarked).toBe(false);
    expect(j.data.uploadUrl).toContain("post-media");
    expect(j.data.bucket).toBe("post-media");
  });

  it("creates a video draft → 202 + Mux direct-upload URL", async () => {
    asAdmin();
    state.tables.horse = { select: { single: { id: "h1" } } };
    state.tables.post = { mutate: { single: { id: "p2", status: "draft", type: "video", horse_id: "h1" } } };
    const r = await POST(postReq({ horseId: "h1", type: "video", sourceTrainerId: "t1" }));
    expect(r.status).toBe(202);
    const j = await r.json();
    expect(j.data.uploadUrl).toBe("https://mux.local/upload");
    expect(j.data.muxUploadId).toBe("up_123");
  });

  it("passes passthrough = post id to Mux (webhook reconcile contract)", async () => {
    asAdmin();
    state.tables.horse = { select: { single: { id: "h1" } } };
    state.tables.post = { mutate: { single: { id: "p2", status: "draft", type: "video", horse_id: "h1" } } };
    await POST(postReq({ horseId: "h1", type: "video", sourceTrainerId: "t1" }));
    expect(createMuxDirectUpload).toHaveBeenCalledWith(expect.objectContaining({ passthrough: "p2" }));
  });

  it("rejects a non video/photo type → 400", async () => {
    asAdmin();
    const r = await POST(postReq({ horseId: "h1", type: "text", sourceTrainerId: "t1" }));
    expect(r.status).toBe(400);
  });

  it("404 horse_not_found when the horse does not exist", async () => {
    asAdmin();
    state.tables.horse = { select: { single: null } };
    const r = await POST(postReq({ horseId: "nope", type: "photo", sourceTrainerId: "t1" }));
    expect(r.status).toBe(404);
    const j = await r.json();
    expect(j.error.code).toBe("horse_not_found");
  });

  it("400 when required fields are missing", async () => {
    asAdmin();
    const r = await POST(postReq({ type: "photo" }));
    expect(r.status).toBe(400);
  });
});

describe("GET /api/admin/posts — list + search", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await GET(new Request("http://t/api/admin/posts"));
    expect(r.status).toBe(403);
  });

  it("returns the list with meta for an admin", async () => {
    asAdmin();
    state.tables.post = { select: { rows: [{ id: "p1" }, { id: "p2" }], count: 2 } };
    const r = await GET(new Request("http://t/api/admin/posts"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data).toHaveLength(2);
    expect(j.meta.count).toBe(2);
  });

  it("?q= applies an ILIKE search over title/body + joined horse/trainer names", async () => {
    asAdmin();
    state.tables.horse = { select: { rows: [{ id: "h1" }] } };
    state.tables.trainer = { select: { rows: [{ id: "t1" }] } };
    state.tables.post = { select: { rows: [{ id: "p1", title: "Melbourne win" }], count: 1 } };
    const r = await GET(new Request("http://t/api/admin/posts?q=melb"));
    expect(r.status).toBe(200);
    const orExpr = state.calls.or.join(" | ");
    expect(orExpr).toContain("title.ilike.%melb%");
    expect(orExpr).toContain("body.ilike.%melb%");
    expect(orExpr).toContain("horse_id.in.(h1)");
    expect(orExpr).toContain("source_trainer_id.in.(t1)");
  });
});
