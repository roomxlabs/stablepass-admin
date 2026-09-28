// ENG-1584 — compose's poster bake client. 404 is the asset-not-ready order
// (the webhook will bake the stored poster_time_s), so it must NOT throw;
// every other failure must, with the route's readable message.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ supabaseBrowser: vi.fn() }));

import { rebakeDraftPoster } from "./api";

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("rebakeDraftPoster", () => {
  it("POSTs { time } to the poster route and reports baked", async () => {
    const f = respond(200, { data: { posterUrl: "posters/p1/1.jpg", posterTimeS: 2.5 } });
    await expect(rebakeDraftPoster("p1", 2.5)).resolves.toBe("baked");
    expect(f).toHaveBeenCalledWith("/api/admin/posts/p1/poster", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ time: 2.5 }),
    });
  });

  it("404 (no playback id yet) resolves not_ready", async () => {
    respond(404, { error: { code: "not_found", message: "Video post not found or has no playable asset." } });
    await expect(rebakeDraftPoster("p1", 1)).resolves.toBe("not_ready");
  });

  it("any other failure throws the route's message", async () => {
    respond(500, { error: { code: "rebake_failed", message: "Poster re-bake failed." } });
    await expect(rebakeDraftPoster("p1", 1)).rejects.toThrow("Poster re-bake failed.");
  });
});
