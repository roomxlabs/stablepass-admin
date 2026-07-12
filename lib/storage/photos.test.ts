import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { signPhoto, signPhotoMap } from "./photos";

// Minimal fake of the Storage surface these helpers touch. Records the paths
// each API was called with so we can assert de-duping / single round-trips.
function fakeSb(opts?: {
  signOne?: (path: string) => string | null;
  signMany?: (paths: string[]) => { path: string | null; signedUrl: string }[];
}) {
  const calls = { one: [] as string[], many: [] as string[][] };
  const sb = {
    storage: {
      from: () => ({
        createSignedUrl: async (path: string) => {
          calls.one.push(path);
          const url = opts?.signOne ? opts.signOne(path) : `https://s/${path}`;
          return { data: url ? { signedUrl: url } : null, error: url ? null : new Error("x") };
        },
        createSignedUrls: async (paths: string[]) => {
          calls.many.push(paths);
          const data = opts?.signMany
            ? opts.signMany(paths)
            : paths.map((p) => ({ path: p, signedUrl: `https://s/${p}` }));
          return { data, error: null };
        },
      }),
    },
  };
  return { sb: sb as unknown as SupabaseClient, calls };
}

describe("signPhoto", () => {
  it("returns null for empty values without hitting storage", async () => {
    const { sb, calls } = fakeSb();
    expect(await signPhoto(sb, "horse-photos", null)).toBeNull();
    expect(await signPhoto(sb, "horse-photos", undefined)).toBeNull();
    expect(await signPhoto(sb, "horse-photos", "")).toBeNull();
    expect(calls.one).toEqual([]);
  });

  it("passes absolute URLs through untouched (no signing)", async () => {
    const { sb, calls } = fakeSb();
    expect(await signPhoto(sb, "horse-photos", "https://cdn/x.jpg")).toBe("https://cdn/x.jpg");
    expect(await signPhoto(sb, "horse-photos", "blob:abc")).toBe("blob:abc");
    expect(calls.one).toEqual([]);
  });

  it("signs a bare object path", async () => {
    const { sb, calls } = fakeSb();
    expect(await signPhoto(sb, "horse-photos", "uuid.jpg")).toBe("https://s/uuid.jpg");
    expect(calls.one).toEqual(["uuid.jpg"]);
  });

  it("returns null when signing fails", async () => {
    const { sb } = fakeSb({ signOne: () => null });
    expect(await signPhoto(sb, "horse-photos", "missing.jpg")).toBeNull();
  });
});

describe("signPhotoMap", () => {
  it("returns an empty map (no round-trip) when there is nothing to sign", async () => {
    const { sb, calls } = fakeSb();
    const m = await signPhotoMap(sb, "horse-photos", [null, undefined, ""]);
    expect(m.size).toBe(0);
    expect(calls.many).toEqual([]);
  });

  it("de-dupes paths into a single batch and keys by the stored value", async () => {
    const { sb, calls } = fakeSb();
    const m = await signPhotoMap(sb, "horse-photos", ["a.jpg", "a.jpg", "b.jpg", null, "a.jpg"]);
    expect(calls.many).toEqual([["a.jpg", "b.jpg"]]);
    expect(m.get("a.jpg")).toBe("https://s/a.jpg");
    expect(m.get("b.jpg")).toBe("https://s/b.jpg");
  });

  it("maps absolute URLs to themselves and does not sign them", async () => {
    const { sb, calls } = fakeSb();
    const m = await signPhotoMap(sb, "horse-photos", ["https://cdn/x.jpg", "p.jpg"]);
    expect(m.get("https://cdn/x.jpg")).toBe("https://cdn/x.jpg");
    expect(m.get("p.jpg")).toBe("https://s/p.jpg");
    expect(calls.many).toEqual([["p.jpg"]]);
  });

  it("omits entries that failed to sign", async () => {
    const { sb } = fakeSb({ signMany: (paths) => paths.map((p) => ({ path: p, signedUrl: p === "ok.jpg" ? "https://s/ok.jpg" : "" })) });
    const m = await signPhotoMap(sb, "horse-photos", ["ok.jpg", "bad.jpg"]);
    expect(m.get("ok.jpg")).toBe("https://s/ok.jpg");
    expect(m.has("bad.jpg")).toBe(false);
  });
});
