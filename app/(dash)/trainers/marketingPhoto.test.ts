import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MARKETING_PHOTO_BUCKET,
  marketingExt,
  marketingPhotoCandidates,
  marketingPhotoPathFor,
  publishMarketingPhoto,
  unpublishMarketingPhoto,
} from "./marketingPhoto";

// ENG-766 — the browser-side copy into the PUBLIC marketing-photos bucket.
// This is the risky half of the ticket, so it is tested directly against a fake
// storage client rather than only through the form: the states the ticket locks
// (copy fails mid-save, photo replaced while visible, toggle off, no photo yet)
// are all about WHICH storage calls happen and what path is reported back.

type Call = { bucket: string; op: string; path?: string; paths?: string[]; opts?: unknown };

function makeFakeSb(script: {
  signedUrl?: string | null;
  uploadError?: { message: string } | null;
  removeError?: { message: string } | null;
}) {
  const calls: Call[] = [];
  const sb = {
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string) => {
          calls.push({ bucket, op: "createSignedUrl", path });
          return script.signedUrl === null
            ? { data: null, error: { message: "no object" } }
            : { data: { signedUrl: script.signedUrl ?? `https://signed.local/${bucket}/${path}` }, error: null };
        },
        upload: async (path: string, _body: unknown, opts?: unknown) => {
          calls.push({ bucket, op: "upload", path, opts });
          return { data: null, error: script.uploadError ?? null };
        },
        remove: async (paths: string[]) => {
          calls.push({ bucket, op: "remove", paths });
          return { data: null, error: script.removeError ?? null };
        },
      }),
    },
  };
  return { sb: sb as unknown as SupabaseClient, calls };
}

const TRAINER_ID = "11111111-2222-3333-4444-555555555555";
const JPG = `trainers/${TRAINER_ID}.jpg`;
const PNG = `trainers/${TRAINER_ID}.png`;

function stubFetch(ok = true, type = "image/jpeg") {
  const spy = vi.fn(async () => ({ ok, blob: async () => ({ type }) }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

const removes = (calls: Call[]) => calls.filter((c) => c.op === "remove");
const removedKeys = (calls: Call[]) => removes(calls).flatMap((c) => c.paths ?? []);

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the public bucket identity", () => {
  // Pinned to the literal, not to the imported constant: every other assertion
  // in this file compares against MARKETING_PHOTO_BUCKET, so repointing that
  // constant at a PRIVATE bucket would make the delete path wipe real trainer
  // photos while every self-referential assertion still passed.
  it("is exactly the bucket W7 created", () => {
    expect(MARKETING_PHOTO_BUCKET).toBe("marketing-photos");
  });

  it("enumerates every key a trainer's public photo could occupy", () => {
    expect(marketingPhotoCandidates(TRAINER_ID)).toEqual([
      `trainers/${TRAINER_ID}.jpg`,
      `trainers/${TRAINER_ID}.jpeg`,
      `trainers/${TRAINER_ID}.png`,
      `trainers/${TRAINER_ID}.webp`,
    ]);
  });
});

describe("marketingExt / marketingPhotoPathFor", () => {
  it("keeps an extension the public bucket actually allows", () => {
    expect(marketingExt("chris-waller-172.jpg")).toBe("jpg");
    expect(marketingExt("chris-waller-172.PNG")).toBe("png");
    expect(marketingExt("chris-waller-172.webp")).toBe("webp");
  });

  it("falls back to jpg for an extension the bucket would reject", () => {
    expect(marketingExt("weird.svg")).toBe("jpg");
    expect(marketingExt("no-extension")).toBe("jpg");
  });

  it("keys the public object by trainer id, with no traversal or absolute path", () => {
    const path = marketingPhotoPathFor(TRAINER_ID, "chris-waller-172.png");
    expect(path).toBe(PNG);
    // Mirrors the DB CHECK on trainer.marketing_photo_path.
    expect(path.startsWith("/")).toBe(false);
    expect(path.includes("..")).toBe(false);
  });

  it("cannot be steered out of the trainers/ prefix by a hostile private path", () => {
    const path = marketingPhotoPathFor(TRAINER_ID, "x.jpg/../../post-media/evil");
    expect(path).toBe(JPG);
  });
});

describe("publishMarketingPhoto — toggle ON", () => {
  it("reads the private original via the signed read and uploads to the PUBLIC bucket", async () => {
    const { sb, calls } = makeFakeSb({});
    const fetchSpy = stubFetch();

    const r = await publishMarketingPhoto(sb, TRAINER_ID, "chris-waller-172.jpg");

    expect(r).toEqual({ ok: true, path: JPG });
    // Down from the PRIVATE bucket…
    expect(calls[0]).toMatchObject({ bucket: "trainer-photos", op: "createSignedUrl", path: "chris-waller-172.jpg" });
    expect(fetchSpy).toHaveBeenCalledOnce();
    // …and up into the PUBLIC one, at the trainer-keyed path.
    expect(calls[1]).toMatchObject({ bucket: "marketing-photos", op: "upload", path: JPG });
    expect((calls[1].opts as { upsert: boolean }).upsert).toBe(true);
    expect((calls[1].opts as { contentType: string }).contentType).toBe("image/jpeg");
  });

  it("never touches any bucket other than trainer-photos and marketing-photos (guardrail)", async () => {
    const { sb, calls } = makeFakeSb({});
    stubFetch();
    await publishMarketingPhoto(sb, TRAINER_ID, "chris-waller-172.jpg");
    for (const c of calls) expect(["trainer-photos", "marketing-photos"]).toContain(c.bucket);
  });

  it("sweeps every OTHER extension after a successful upload, keeping the one just written", async () => {
    const { sb, calls } = makeFakeSb({});
    stubFetch();
    await publishMarketingPhoto(sb, TRAINER_ID, "chris-waller-172.jpg");
    expect(removedKeys(calls)).toEqual([
      `trainers/${TRAINER_ID}.jpeg`,
      PNG,
      `trainers/${TRAINER_ID}.webp`,
    ]);
    expect(removedKeys(calls)).not.toContain(JPG);
  });

  it("refreshes the public copy in place when the photo is replaced while visible", async () => {
    const { sb, calls } = makeFakeSb({});
    stubFetch();

    const r = await publishMarketingPhoto(sb, TRAINER_ID, "chris-waller-999.jpg", JPG);

    expect(r).toEqual({ ok: true, path: JPG });
    // Same key → upsert overwrites, and the live key is never swept.
    expect(calls.filter((c) => c.op === "upload")).toHaveLength(1);
    expect(removedKeys(calls)).not.toContain(JPG);
  });

  it("removes the superseded object when the replacement changes the extension", async () => {
    // Without this, swapping a jpg for a png leaves the jpg anonymously
    // fetchable at its old public URL forever.
    const { sb, calls } = makeFakeSb({});
    stubFetch(true, "image/png");

    const r = await publishMarketingPhoto(sb, TRAINER_ID, "chris-waller-999.png", JPG);

    expect(r).toEqual({ ok: true, path: PNG });
    expect(removedKeys(calls)).toContain(JPG);
    expect(removes(calls)[0].bucket).toBe("marketing-photos");
  });

  it("REGRESSION: a retry still removes the superseded key after an earlier delete failed", async () => {
    // The old code derived the deletion target from the recorded path. After a
    // failed remove the path had already advanced to the new key, so `previous
    // === target` and the retry skipped the delete entirely — reporting success
    // while the old object stayed public. The sweep is id-derived, so a retry
    // that starts from the NEW path still removes the stale one.
    const { sb, calls } = makeFakeSb({});
    stubFetch(true, "image/png");

    const r = await publishMarketingPhoto(sb, TRAINER_ID, "chris-waller-999.png", PNG);

    expect(r.ok).toBe(true);
    expect(removedKeys(calls)).toContain(JPG);
  });

  it("allows toggle ON with no photo yet — null path, no upload", async () => {
    const { sb, calls } = makeFakeSb({});
    const r = await publishMarketingPhoto(sb, TRAINER_ID, null);
    expect(r).toEqual({ ok: true, path: null });
    expect(calls.some((c) => c.op === "upload")).toBe(false);
  });

  it("cleans up any published object when the trainer no longer has a private photo", async () => {
    const { sb, calls } = makeFakeSb({});
    const r = await publishMarketingPhoto(sb, TRAINER_ID, null, JPG);
    expect(r).toEqual({ ok: true, path: null });
    expect(removedKeys(calls)).toEqual(marketingPhotoCandidates(TRAINER_ID));
  });
});

describe("publishMarketingPhoto — refusing what the public bucket must not hold", () => {
  it("REFUSES a format outside the bucket's allow-list instead of relabelling it", async () => {
    // The private bucket sets no allowed_mime_types, so an SVG can live there.
    // Uploading it under a jpeg label would launder exactly what W7's allow-list
    // exists to stop (an image/svg+xml object is a live document on a public origin).
    const { sb, calls } = makeFakeSb({});
    stubFetch(true, "image/svg+xml");

    const r = await publishMarketingPhoto(sb, TRAINER_ID, "logo.svg");

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.message).toMatch(/not a supported format/i);
    expect(calls.some((c) => c.op === "upload")).toBe(false);
  });

  it("declares the real content type on the upload, never a guessed one", async () => {
    const { sb, calls } = makeFakeSb({});
    stubFetch(true, "image/webp");
    await publishMarketingPhoto(sb, TRAINER_ID, "photo.webp");
    const up = calls.find((c) => c.op === "upload");
    expect((up!.opts as { contentType: string }).contentType).toBe("image/webp");
  });
});

describe("publishMarketingPhoto — the copy fails mid-save", () => {
  it("reports a retryable failure when the private original cannot be signed", async () => {
    const { sb, calls } = makeFakeSb({ signedUrl: null });
    const r = await publishMarketingPhoto(sb, TRAINER_ID, "chris-waller-172.jpg");
    expect(r.ok).toBe(false);
    expect(r.path).toBeNull();
    expect(calls.some((c) => c.op === "upload")).toBe(false);
  });

  it("reports a retryable failure when the signed download 404s", async () => {
    const { sb, calls } = makeFakeSb({});
    stubFetch(false);
    const r = await publishMarketingPhoto(sb, TRAINER_ID, "chris-waller-172.jpg");
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.op === "upload")).toBe(false);
  });

  it("surfaces the storage reason, so a permanent rejection is not an endless retry", async () => {
    // The public bucket caps at 10 MB and the private one has no limit, so
    // "Payload too large" is reachable and will never succeed on retry.
    const { sb } = makeFakeSb({ uploadError: { message: "Payload too large" } });
    stubFetch();
    const r = await publishMarketingPhoto(sb, TRAINER_ID, "huge.jpg");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.message).toContain("Payload too large");
  });

  it("survives a network throw mid-copy rather than rejecting", async () => {
    const { sb } = makeFakeSb({});
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const r = await publishMarketingPhoto(sb, TRAINER_ID, "chris-waller-172.jpg");
    expect(r.ok).toBe(false);
  });

  it("keeps the PREVIOUS path on failure, so a live object is never orphaned by a null", async () => {
    const { sb } = makeFakeSb({ uploadError: { message: "boom" } });
    stubFetch();
    const r = await publishMarketingPhoto(sb, TRAINER_ID, "chris-waller-999.jpg", JPG);
    expect(r.ok).toBe(false);
    expect(r.path).toBe(JPG);
  });
});

describe("unpublishMarketingPhoto — toggle OFF", () => {
  it("deletes the public object and reports the path should become null", async () => {
    const { sb, calls } = makeFakeSb({});

    const r = await unpublishMarketingPhoto(sb, TRAINER_ID, JPG);

    expect(r).toEqual({ ok: true, path: null });
    expect(removes(calls)[0].bucket).toBe("marketing-photos");
    expect(removedKeys(calls)).toContain(JPG);
  });

  it("REGRESSION: sweeps even when the stored path is null", async () => {
    // A null path does not prove there is no public object — it is precisely the
    // state left behind when an upload succeeded but recording the path failed.
    // Treating null as "nothing to do" left the object anonymously fetchable at
    // a fully derivable URL after the trainer was taken off the site.
    const { sb, calls } = makeFakeSb({});

    const r = await unpublishMarketingPhoto(sb, TRAINER_ID, null);

    expect(r).toEqual({ ok: true, path: null });
    expect(removedKeys(calls)).toEqual(marketingPhotoCandidates(TRAINER_ID));
  });

  it("KEEPS the path when the delete fails, so the retry knows what to remove", async () => {
    const { sb } = makeFakeSb({ removeError: { message: "storage down" } });
    const r = await unpublishMarketingPhoto(sb, TRAINER_ID, JPG);
    expect(r.ok).toBe(false);
    expect(r.path).toBe(JPG);
    if (r.ok) throw new Error("unreachable");
    expect(r.message).toMatch(/could not be removed/i);
  });

  it("touches only the public bucket — never the private one (guardrail)", async () => {
    const { sb, calls } = makeFakeSb({});
    await unpublishMarketingPhoto(sb, TRAINER_ID, JPG);
    for (const c of calls) expect(c.bucket).toBe("marketing-photos");
  });
});
