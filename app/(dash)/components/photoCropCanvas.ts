// ENG-749 — the browser half of the crop: decoding the picked file and writing
// the cropped bytes with a canvas.
//
// Split out from photoCrop.ts (pure maths) and from the component so that the
// component test can mock EXACTLY this and nothing else. jsdom implements
// neither `canvas.getContext` nor `URL.createObjectURL`, so anything that
// touches them is untestable in vitest and has to be provable in the Playwright
// evidence instead.

import type { CropRect, OutputFormat } from "./photoCrop";
import { needsFill, outputEdge, placement } from "./photoCrop";

/**
 * Whether this browser can actually perform a crop.
 *
 * Probed rather than assumed: jsdom DEFINES `getContext` and then throws "not
 * implemented" when it is called, so a `typeof` check passes and the crop then
 * fails at the moment the admin presses Apply. Calling it here is what makes
 * the fallback honest — if this returns false the component never offers a crop
 * step at all and the original file uploads exactly as it did before.
 */
export function canvasSupported(): boolean {
  if (typeof document === "undefined" || typeof URL === "undefined") return false;
  if (typeof URL.createObjectURL !== "function") return false;
  try {
    const canvas = document.createElement("canvas");
    if (typeof canvas.getContext !== "function" || typeof canvas.toBlob !== "function") return false;
    return canvas.getContext("2d") != null;
  } catch {
    return false;
  }
}

export type LoadedImage = {
  /** Decoded element, drawn onto the canvas at Apply time. */
  el: HTMLImageElement;
  /** Object URL backing it — the same one the viewport displays. */
  url: string;
  width: number;
  height: number;
  release(): void;
};

/**
 * Decode the picked file. Returns null for anything that will not decode (a
 * renamed .txt, a corrupt download) so the caller can fall back rather than
 * showing an empty crop viewport the admin cannot make sense of.
 */
export async function loadImage(file: Blob): Promise<LoadedImage | null> {
  if (!canvasSupported()) return null;
  const url = URL.createObjectURL(file);
  const release = () => URL.revokeObjectURL(url);
  try {
    const el = await new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
    if (!el || !el.naturalWidth || !el.naturalHeight) {
      release();
      return null;
    }
    return { el, url, width: el.naturalWidth, height: el.naturalHeight, release };
  } catch {
    release();
    return null;
  }
}

/**
 * Draw `rect` of `image` into a square canvas and return the encoded bytes.
 *
 * Returns null on any failure, which the caller treats as "upload the original"
 * — a photo saved uncropped is a far better outcome than a save that dies at
 * the last step with the admin's framing lost.
 */
export async function cropToBlob(
  image: HTMLImageElement,
  rect: CropRect,
  format: OutputFormat,
): Promise<Blob | null> {
  try {
    const edge = outputEdge(rect.size);
    const canvas = document.createElement("canvas");
    canvas.width = edge;
    canvas.height = edge;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // JPEG has no alpha channel, so a transparent PNG cropped to JPEG would
    // composite onto the canvas's default TRANSPARENT BLACK and arrive as a
    // black square. White matches the cream/white surfaces every avatar renders
    // against. PNG output keeps its transparency and must not be painted over.
    if (format.mime === "image/jpeg") {
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, edge, edge);
    }

    ctx.imageSmoothingQuality = "high";

    const source = { width: image.naturalWidth, height: image.naturalHeight };
    if (needsFill(source, rect)) {
      // Sub-fit zoom: the photo letterboxes inside the square, and the
      // uncovered surround is a BLURRED COVER pass of the same photo — the
      // Instagram treatment, and the one fill that looks intentional on every
      // image (flat bands read as a rendering fault on the browse rows). The
      // cover pass is scaled a touch past the edges so the blur never samples
      // its own transparent border and vignettes.
      const coverScale = Math.max(edge / source.width, edge / source.height) * 1.1;
      const dw = source.width * coverScale;
      const dh = source.height * coverScale;
      if (typeof ctx.filter === "string") {
        ctx.filter = `blur(${Math.max(12, Math.round(edge / 30))}px)`;
        ctx.drawImage(image, (edge - dw) / 2, (edge - dh) / 2, dw, dh);
        ctx.filter = "none";
      } else {
        // No ctx.filter (older Safari): a downscale/upscale bounce through a
        // tiny offscreen canvas is a cheap box blur with the same read.
        const tiny = document.createElement("canvas");
        tiny.width = Math.max(1, Math.round(edge / 24));
        tiny.height = tiny.width;
        const tctx = tiny.getContext("2d");
        if (tctx) {
          tctx.drawImage(image, (tiny.width - (dw / edge) * tiny.width) / 2,
            (tiny.height - (dh / edge) * tiny.height) / 2,
            (dw / edge) * tiny.width, (dh / edge) * tiny.height);
          ctx.drawImage(tiny, 0, 0, edge, edge);
        }
      }
    }

    // The SHARP photo, via the shared placement mapping (photoCrop.ts) — the
    // same maths the dialog's preview uses, so the stored bytes cannot differ
    // from what the admin saw. The source rect is the intersection with the
    // image, so drawImage never samples outside it (per-spec transparent
    // black, historically browser-dependent).
    const put = placement(source, rect, edge);
    if (put.sw > 0 && put.sh > 0) {
      ctx.drawImage(image, put.sx, put.sy, put.sw, put.sh, put.dx, put.dy, put.dw, put.dh);
    }

    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), format.mime, format.quality);
    });
  } catch {
    return null;
  }
}
