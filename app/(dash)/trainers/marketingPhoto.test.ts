import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MARKETING_PHOTO_BUCKET,
  marketingExt,
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

function stubFetch(ok = true, type = "image/jpeg") {
  const spy = vi.fn(async () => ({ ok, blob: async () => ({ type }) }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("marketingExt / marketingPhotoPathFor", () => {
  it("keeps an extension the public bucket actually allows", () => {
    expect(marketingExt("chris-waller-172.jpg")).toBe("jpg");
    expect(marketingExt("chris-waller-172.PNG")).toBe("png");
    expect(marketingExt("chris-waller-172.webp")).toBe("webp");
  });

  it("falls back to jpg for an extension the bucket would reject", () => {
    // The bucket's allowed_mime_types is jpeg/png/webp only (W7), so uploading a
    // .gif/.svg/extensionless object could never succeed.
    expect(marketingExt("weird.svg")).toBe("jpg");
    expect(marketingExt("no-extension")).toBe("jpg");
  });

  it("keys the public object by trainer id, with no traversal or absolute path", () => {
    const path = marketingPhotoPathFor(TRAINER_ID, "chris-waller-172.png");
    expect(path).toBe(`trainers/${TRAINER_ID}.png`);
    // Mirrors the DB CHECK on trainer.marketing_photo_path.
    expect(path.startsWith("/")).toBe(false);
    expect(path.includes("..")).toBe(false);
  });
});

describe("publishMarketingPhoto — toggle ON", () => {
  it("reads the private original via the signed read and uploads to the PUBLIC bucket", async () => {
    const { sb, calls } = makeFakeSb({});
    const fetchSpy = stubFetch();

    const r = await publishMarketingPhoto(sb, TRAINER_ID, "chris-waller-172.jpg");

    expect(r).toEqual({ ok: true, path: `trainers/${TRAINER_ID}.jpg` });
    // Down from the PRIVATE bucket…
    expect(calls[0]).toMatchObject({ bucket: "trainer-photos", op: "createSignedUrl", path: "chris-waller-172.jpg" });
    expect(fetchSpy).toHaveBeenCalledOnce();
    // …and up into the PUBLIC one, at the trainer-keyed path.
    expect(calls[1]).toMatchObject({
      bucket: MARKETING_PHOTO_BUCKET,
      op: "upload",
      path: `trainers/${TRAINER_ID}.jpg`,
    });
    expect((calls[1].opts as { upsert: boolean; contentType: string }).upsert).toBe(true);
    expect((calls[1].opts as { contentType: string }).contentType).toBe("image/jpeg");
  });

  it("never touches any bucket other than trainer-photos and marketing-photos (guardrail)", async () => {
    const { sb, calls } = makeFakeSb({});
    stubFetch();
    await publishMarketingPhoto(sb, TRAINER_ID, "chris-waller-172.jpg");
    for (const c of calls) expect(["trainer-photos", MARKETING_PHOTO_BUCKET]).toContain(c.bucket);
  });

  it("refreshes the public copy in place when the photo is replaced while visible", async () => {
    const { sb, calls } = makeFakeSb({});
    stubFetch();
    const previous = `trainers/${TRAINER_ID}.jpg`;

    const r = await publishMarketingPhoto(sb, TRAINER_ID, "chris-waller-999.jpg", previous);

    expect(r).toEqual({ ok: true, path: previous });
    // Same path → upsert overwrites; nothing is orphaned, so nothing is removed.
    expect(calls.filter((c) => c.op === "upload")).toHaveLength(1);
    expect(calls.some((c) => c.op === "remove")).toBe(false);
  });

  it("deletes the old object when the replacement changes the extension", async () => {
    // Without this, swapping a jpg for a png would leave the jpg anonymously
    // fetchable at its old public URL forever.
    const { sb, calls } = makeFakeSb({});
    stubFetch(true, "image/png");
    const previous = `trainers/${TRAINER_ID}.jpg`;

    const r = await publishMarketingPhoto(sb, TRAINER_ID, "chris-waller-999.png", previous);

    expect(r).toEqual({ ok: true, path: `trainers/${TRAINER_ID}.png` });
    const removed = calls.find((c) => c.op === "remove");
    expect(removed?.paths).toEqual([previous]);
    expect(removed?.bucket).toBe(MARKETING_PHOTO_BUCKET);
  });

  it("allows toggle ON with no photo yet — null path, no upload", async () => {
    const { sb, calls } = makeFakeSb({});
    const r = await publishMarketingPhoto(sb, TRAINER_ID, null);
    expect(r).toEqual({ ok: true, path: null });
    expect(calls).toHaveLength(0);
  });

  it("cleans up a published object when the trainer no longer has a private photo", async () => {
    const { sb, calls } = makeFakeSb({});
    const previous = `trainers/${TRAINER_ID}.jpg`;
    const r = await publishMarketingPhoto(sb, TRAINER_ID, null, previous);
    expect(r).toEqual({ ok: true, path: null });
    expect(calls.find((c) => c.op === "remove")?.paths).toEqual([previous]);
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

  it("reports a retryable failure when the public upload is rejected", async () => {
    const { sb } = makeFakeSb({ uploadError: { message: "mime type not allowed" } });
    stubFetch();
    const r = await publishMarketingPhoto(sb, TRAINER_ID, "chris-waller-172.jpg");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.message).toMatch(/not been published/i);
  });

  it("survives a network throw mid-copy rather than rejecting", async () => {
    const { sb } = makeFakeSb({});
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const r = await publishMarketingPhoto(sb, TRAINER_ID, "chris-waller-172.jpg");
    expect(r.ok).toBe(false);
  });

  it("keeps the PREVIOUS path on failure, so a live object is never orphaned by a null", async () => {
    // If a failed re-copy nulled the path, the old object would stay public with
    // nothing in the DB pointing at it — unreachable for any later cleanup.
    const { sb } = makeFakeSb({ uploadError: { message: "boom" } });
    stubFetch();
    const previous = `trainers/${TRAINER_ID}.jpg`;
    const r = await publishMarketingPhoto(sb, TRAINER_ID, "chris-waller-999.jpg", previous);
    expect(r.ok).toBe(false);
    expect(r.path).toBe(previous);
  });
});

describe("unpublishMarketingPhoto — toggle OFF", () => {
  it("deletes the public object and reports the path should become null", async () => {
    const { sb, calls } = makeFakeSb({});
    const published = `trainers/${TRAINER_ID}.jpg`;

    const r = await unpublishMarketingPhoto(sb, published);

    expect(r).toEqual({ ok: true, path: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ bucket: MARKETING_PHOTO_BUCKET, op: "remove", paths: [published] });
  });

  it("is a no-op when nothing was ever published", async () => {
    const { sb, calls } = makeFakeSb({});
    const r = await unpublishMarketingPhoto(sb, null);
    expect(r).toEqual({ ok: true, path: null });
    expect(calls).toHaveLength(0);
  });

  it("KEEPS the path when the delete fails, so the retry knows what to remove", async () => {
    const { sb } = makeFakeSb({ removeError: { message: "storage down" } });
    const published = `trainers/${TRAINER_ID}.jpg`;
    const r = await unpublishMarketingPhoto(sb, published);
    expect(r.ok).toBe(false);
    expect(r.path).toBe(published);
    if (r.ok) throw new Error("unreachable");
    expect(r.message).toMatch(/could not be removed/i);
  });
});
