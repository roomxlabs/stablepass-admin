import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));

// ENG-1597 — the route's own `cleanupVideos` call goes through Mux; mocked
// the same way the sibling routes' tests do it.
const cleanupMuxVideo = vi.fn<
  (v: { videoId: string; assetId?: string | null; uploadId?: string | null }) => Promise<void>
>(async () => undefined);
vi.mock("@/lib/mux", () => ({
  MuxError: class MuxError extends Error {},
  createMuxDirectUpload: vi.fn(),
  cleanupMuxVideo: (v: { videoId: string; assetId?: string | null; uploadId?: string | null }) =>
    cleanupMuxVideo(v),
}));

import { DELETE } from "./route";

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}
function asNonAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: false } } };
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request("http://t", { method: "DELETE" });

beforeEach(() => {
  Object.assign(state, blankState());
  cleanupMuxVideo.mockClear();
});

describe("DELETE /api/admin/posts/:id/delete — hard delete, ANY status", () => {
  it("403s for a non-admin (guardrail §1)", async () => {
    asNonAdmin();
    const r = await DELETE(req(), ctx("p1"));
    expect(r.status).toBe(403);
  });

  it("403s an admin whose session is only AAL1", async () => {
    asAdmin();
    state.aal = "aal1";
    const r = await DELETE(req(), ctx("p1"));
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("mfa_required");
  });

  // The whole point of the route: the draft-only sibling 409s these, which is
  // why demo data could never be cleaned out of production.
  for (const status of ["draft", "scheduled", "published", "unpublished"] as const) {
    it(`204s a ${status} post`, async () => {
      asAdmin();
      state.tables.post = { select: { single: { id: "p1", status } }, mutate: {} };
      const r = await DELETE(req(), ctx("p1"));
      expect(r.status).toBe(204);
    });
  }

  it("deletes exactly the addressed row", async () => {
    asAdmin();
    state.tables.post = { select: { single: { id: "p1" } }, mutate: {} };
    await DELETE(req(), ctx("p1"));
    const del = state.calls.mutations.find((m) => m.table === "post" && m.op === "delete");
    expect(del).toBeTruthy();
    expect(del?.filters).toEqual([{ column: "id", value: "p1" }]);
  });

  it("404s a missing post rather than reporting a silent success", async () => {
    asAdmin();
    state.tables.post = { select: { single: null } };
    const r = await DELETE(req(), ctx("p1"));
    expect(r.status).toBe(404);
  });

  // ENG-1597 — hard-deleting a video post must not leak its Mux assets/uploads.
  it("cleans up an asset row (DELETE) and an upload-only row (cancel), both", async () => {
    asAdmin();
    // ENG-1597 — the delete now scopes `.select("id")` off the mutation, so
    // cleanup only runs once the row it actually removed comes back.
    state.tables.post = {
      select: { single: { id: "p1", status: "published" } },
      mutate: { rows: [{ id: "p1" }] },
    };
    state.tables.post_video = {
      select: {
        rows: [
          { id: "pv0", sort_order: 0, status: "ready", mux_upload_id: null, mux_asset_id: "as_0" },
          { id: "pv1", sort_order: 1, status: "uploading", mux_upload_id: "up_1", mux_asset_id: null },
        ],
      },
    };
    const r = await DELETE(req(), ctx("p1"));
    expect(r.status).toBe(204);
    expect(cleanupMuxVideo).toHaveBeenCalledWith({ videoId: "pv0", assetId: "as_0", uploadId: null });
    expect(cleanupMuxVideo).toHaveBeenCalledWith({ videoId: "pv1", assetId: null, uploadId: "up_1" });
  });

  it("a failed post delete → no cleanup call at all", async () => {
    asAdmin();
    state.tables.post = {
      select: { single: { id: "p1", status: "published" } },
      mutate: { error: { message: "delete failed" } },
    };
    state.tables.post_video = {
      select: { rows: [{ id: "pv0", sort_order: 0, status: "ready", mux_upload_id: null, mux_asset_id: "as_0" }] },
    };
    const r = await DELETE(req(), ctx("p1"));
    expect(r.status).toBe(400);
    expect(cleanupMuxVideo).not.toHaveBeenCalled();
  });

  // ENG-1597 — the addressed row can vanish (a concurrent hard delete winning
  // the race) between the existence read above and this delete: PostgREST
  // reports that as NO error and ZERO rows, not a failure. Still 204 (the row
  // is gone either way), but THIS request did not remove it, so its Mux
  // assets must not be touched twice / raced against the other request's own
  // cleanup.
  it("the addressed row is already gone by the time the delete runs (0 rows, no error) → 204, no cleanup call", async () => {
    asAdmin();
    state.tables.post = { select: { single: { id: "p1", status: "published" } }, mutate: { rows: [] } };
    state.tables.post_video = {
      select: { rows: [{ id: "pv0", sort_order: 0, status: "ready", mux_upload_id: null, mux_asset_id: "as_0" }] },
    };
    const r = await DELETE(req(), ctx("p1"));
    expect(r.status).toBe(204);
    expect(cleanupMuxVideo).not.toHaveBeenCalled();
  });
});
