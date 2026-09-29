// ENG-1584 — compose's poster bake client. 404 is the asset-not-ready order
// (the webhook will bake the stored poster_time_s), so it must NOT throw;
// every other failure must, with the route's readable message.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ supabaseBrowser: vi.fn() }));

import { rebakeDraftPoster, uploadVideoToMux, UploadAbortedError } from "./api";

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * ENG-1598 review — a minimal, scriptable stand-in for `XMLHttpRequest`
 * (the test environment is `node`, which has no real one). `open`/`send` are
 * recorded so a test can prove the PUT target and body; `respondOk` /
 * `respondError` / `simulateAbort` drive the three ways the real object
 * settles, mirroring `uploadVideoToMux`'s `onload`/`onerror`/`onabort`.
 */
class FakeXHR {
  static instances: FakeXHR[] = [];
  method?: string;
  url?: string;
  sentBody?: unknown;
  status = 0;
  aborted = false;
  upload = { onprogress: null as ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXHR.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  send(body: unknown) {
    this.sentBody = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  respondOk(status = 200) {
    this.status = status;
    this.onload?.();
  }
  respondError(status = 500) {
    this.status = status;
    this.onload?.();
  }
}

function stubXHR() {
  FakeXHR.instances = [];
  vi.stubGlobal(
    "XMLHttpRequest",
    FakeXHR as unknown as typeof XMLHttpRequest,
  );
  return FakeXHR;
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

describe("uploadVideoToMux — ENG-1598 review (abortable)", () => {
  const file = new File([new Uint8Array([1, 2, 3])], "a.mp4", { type: "video/mp4" });

  it("resolves on a 2xx PUT (no signal)", async () => {
    const XHR = stubXHR();
    const p = uploadVideoToMux("https://mux.up/1", file);
    XHR.instances[0].respondOk(200);
    await expect(p).resolves.toBeUndefined();
    expect(XHR.instances[0].method).toBe("PUT");
    expect(XHR.instances[0].url).toBe("https://mux.up/1");
  });

  it("an already-aborted signal rejects immediately with UploadAbortedError, without opening the request", async () => {
    const XHR = stubXHR();
    const ctrl = new AbortController();
    ctrl.abort();
    const p = uploadVideoToMux("https://mux.up/1", file, undefined, ctrl.signal);
    await expect(p).rejects.toBeInstanceOf(UploadAbortedError);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(XHR.instances).toHaveLength(0);
  });

  it("aborting mid-flight calls xhr.abort() and rejects with UploadAbortedError", async () => {
    const XHR = stubXHR();
    const ctrl = new AbortController();
    const p = uploadVideoToMux("https://mux.up/1", file, undefined, ctrl.signal);
    expect(XHR.instances).toHaveLength(1);
    expect(XHR.instances[0].aborted).toBe(false);
    ctrl.abort();
    expect(XHR.instances[0].aborted).toBe(true);
    await expect(p).rejects.toBeInstanceOf(UploadAbortedError);
  });

  it("a normal failure after an abort listener was attached still rejects with the plain error, not AbortError", async () => {
    const XHR = stubXHR();
    const ctrl = new AbortController();
    const p = uploadVideoToMux("https://mux.up/1", file, undefined, ctrl.signal);
    XHR.instances[0].respondError(500);
    await expect(p).rejects.toThrow("Upload failed (500).");
  });
});
