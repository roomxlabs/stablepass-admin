// ENG-749 — the browser half of the crop: decoding the picked file and writing
// the cropped bytes with a canvas.
//
// Split out from photoCrop.ts (pure maths) and from the component so that the
// component test can mock EXACTLY this and nothing else. jsdom implements
// neither `canvas.getContext` nor `URL.createObjectURL`, so anything that
// touches them is untestable in vitest and has to be provable in the Playwright
// evidence instead.

import type { CropRect, OutputFormat } from "./photoCrop";
import { outputEdge } from "./photoCrop";

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
    ctx.drawImage(image, rect.x, rect.y, rect.size, rect.size, 0, 0, edge, edge);

    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), format.mime, format.quality);
    });
  } catch {
    return null;
  }
}
