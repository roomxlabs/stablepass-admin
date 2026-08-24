// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import HorseForm, { type Trainer } from "./HorseForm";

// ENG-749 — the crop step, mirrored from TrainerForm.test.tsx. The assertion
// that matters throughout is on the BODY handed to Storage, not the path: a
// crop that changed the filename and nothing else would pass every path-based
// check while storing the original photo.

const h = vi.hoisted(() => ({
  storage: [] as {
    bucket: string;
    op: string;
    path?: string;
    body?: unknown;
    contentType?: string;
  }[],
  script: {
    // jsdom implements no canvas, so the shipped fallback (upload the
    // original) is what runs by default. Flipping this on simulates a real
    // browser so the crop path itself can be exercised.
    canvas: false,
    cropBlob: null as Blob | null,
  },
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));
// ONLY the canvas half is mocked. The crop arithmetic in photoCrop.ts stays
// real, so these tests exercise the actual rect the component computes and
// hand it to a stand-in encoder.
vi.mock("../components/photoCropCanvas", () => ({
  canvasSupported: () => h.script.canvas,
  loadImage: async () =>
    h.script.canvas
      ? {
          el: {} as HTMLImageElement,
          url: "blob:crop-source",
          width: 4000,
          height: 2000,
          release: () => {},
        }
      : null,
  cropToBlob: async () => h.script.cropBlob,
}));
vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: () => ({
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string) => {
          h.storage.push({ bucket, op: "createSignedUrl", path });
          return { data: { signedUrl: `https://signed.local/${bucket}/${path}` }, error: null };
        },
        upload: async (path: string, body: unknown, opts?: { contentType?: string }) => {
          h.storage.push({ bucket, op: "upload", path, body, contentType: opts?.contentType });
          return { data: null, error: null };
        },
      }),
    },
  }),
}));

type Bff = { url: string; method?: string; body: Record<string, unknown> | null };
let bff: Bff[] = [];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      bff.push({
        url: String(url),
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return { ok: true, status: 200, json: async () => ({ data: {} }) };
    }),
  );
}

const TRAINER: Trainer = {
  id: "22222222-3333-4444-5555-666666666666",
  display_name: "Chris Waller",
  stable_name: "Chris Waller Racing",
};

beforeEach(() => {
  h.storage.length = 0;
  h.script.canvas = false;
  h.script.cropBlob = null;
  bff = [];
  push.mockClear();
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HorseForm — profile photo crop (ENG-749)", () => {
  const pick = (container: HTMLElement, file: File) =>
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });

  const jpeg = () => new File(["original-jpeg-bytes"], "mahogany.jpg", { type: "image/jpeg" });
  const png = () => new File(["original-png-bytes"], "logo.png", { type: "image/png" });

  const upload = () => h.storage.find((c) => c.op === "upload" && c.bucket === "horse-photos");

  describe("in a browser that can crop", () => {
    beforeEach(() => {
      h.script.canvas = true;
      h.script.cropBlob = new Blob(["cropped-bytes"], { type: "image/jpeg" });
    });

    it("opens the crop dialog on pick and uploads nothing until it is resolved", async () => {
      const { container } = render(<HorseForm mode="create" trainers={[TRAINER]} />);
      pick(container, jpeg());

      expect(await screen.findByTestId("photo-crop-dialog")).toBeTruthy();
      expect(h.storage.filter((c) => c.op === "upload")).toHaveLength(0);
    });

    it("uploads the CROPPED blob on Apply crop, not the file the admin picked", async () => {
      const file = jpeg();
      const { container } = render(<HorseForm mode="create" trainers={[TRAINER]} />);
      pick(container, file);
      fireEvent.click(await screen.findByTestId("photo-crop-apply"));
      await screen.findByText("Photo uploaded");

      const up = upload()!;
      expect(up.body).toBe(h.script.cropBlob);
      // The original File must NOT be what was stored.
      expect(up.body).not.toBe(file);
      expect(up.body).not.toBeInstanceOf(File);
    });

    it("uploads the ORIGINAL file, unchanged, on Use as-is", async () => {
      const file = jpeg();
      const { container } = render(<HorseForm mode="create" trainers={[TRAINER]} />);
      pick(container, file);
      fireEvent.click(await screen.findByTestId("photo-crop-use-as-is"));
      await screen.findByText("Photo uploaded");

      const up = upload()!;
      // Identity, not content: the very same File object reaches Storage, so
      // nothing re-encoded it.
      expect(up.body).toBe(file);
      expect(up.body).toBeInstanceOf(File);
    });

    it("names the object for the BYTES, not for the picked filename", async () => {
      // The output format follows the file's TYPE, so a misnamed pick must
      // still land on the right key and content type.
      const { container } = render(<HorseForm mode="create" trainers={[TRAINER]} />);
      pick(container, new File(["x"], "misnamed.png", { type: "image/jpeg" }));
      fireEvent.click(await screen.findByTestId("photo-crop-apply"));
      await screen.findByText("Photo uploaded");

      expect(upload()!.path).toMatch(/\.jpg$/);
      expect(upload()!.contentType).toBe("image/jpeg");
    });

    it("keeps a PNG a PNG when the crop preserves it, so transparency survives", async () => {
      h.script.cropBlob = new Blob(["cropped-png"], { type: "image/png" });
      const { container } = render(<HorseForm mode="create" trainers={[TRAINER]} />);
      pick(container, png());
      fireEvent.click(await screen.findByTestId("photo-crop-apply"));
      await screen.findByText("Photo uploaded");

      expect(upload()!.path).toMatch(/\.png$/);
      expect(upload()!.contentType).toBe("image/png");
    });

    it("uploads nothing at all when the crop is cancelled", async () => {
      const { container } = render(<HorseForm mode="create" trainers={[TRAINER]} />);
      pick(container, jpeg());
      fireEvent.click(await screen.findByTestId("photo-crop-cancel"));

      await waitFor(() => expect(screen.queryByTestId("photo-crop-dialog")).toBeNull());
      expect(h.storage.filter((c) => c.op === "upload")).toHaveLength(0);
      expect(screen.queryByText("Photo uploaded")).toBeNull();
    });
  });

  describe("in a browser with no canvas", () => {
    it("skips the crop dialog entirely and uploads the original, as before this ticket", async () => {
      const file = jpeg();
      const { container } = render(<HorseForm mode="create" trainers={[TRAINER]} />);
      pick(container, file);
      await screen.findByText("Photo uploaded");

      expect(screen.queryByTestId("photo-crop-dialog")).toBeNull();
      expect(upload()!.body).toBe(file);
      expect(upload()!.body).toBeInstanceOf(File);
    });
  });
});
