// ENG-749 — the crop maths, as pure functions over SOURCE-pixel coordinates.
//
// Kept free of the DOM on purpose. The canvas half lives in photoCropCanvas.ts
// so that (a) this can be unit-tested for real rather than through a mock, and
// (b) the component test can mock only the canvas, which jsdom cannot run.
//
// The model, and why it is expressed in source pixels rather than screen ones:
//
//   The crop is a SQUARE of side `size` at `(x, y)` in the source image's own
//   pixel space. The on-screen viewport is only an affordance — it changes with
//   the browser window, and pinning the maths to it would make the same gesture
//   produce a different stored image on a laptop and an external monitor.
//
//   `zoom` 1 means "the largest square that fits inside the source", i.e. the
//   whole of the shorter edge. That single definition covers the two edge cases
//   the ticket names without a special case for either: a huge photo starts
//   fully zoomed out, and a source SMALLER than the viewport is still fully
//   visible at zoom 1 (the viewport scales the square up for display, but the
//   stored bytes are never upscaled — see outputEdge).
//
//   Because the rect is clamped inside the source, the crop can never include
//   area the image does not cover, so the output never has empty edges.

/**
 * Longest edge of the written image. Also the fix for oversized uploads: a
 * 6000px phone photo lands as 1200px. Never an UPSCALE — see outputEdge.
 */
export const MAX_OUTPUT_EDGE = 1200;

export const JPEG_QUALITY = 0.9;

export const ZOOM_MIN = 1;

/** Hard ceiling on magnification, independent of how large the source is. */
export const ZOOM_CEILING = 4;

/**
 * A crop smaller than this many source pixels is not a crop, it is a mistake —
 * it would store a badly pixelated avatar. It also stops the zoom slider from
 * running off the end of a small source.
 */
export const MIN_CROP_SIDE = 48;

export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type CropRect = { x: number; y: number; size: number };

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(Math.max(v, lo), hi);
}

/** The largest square that fits inside the source: its shorter edge. */
export function maxCropSide(source: Size): number {
  return Math.max(1, Math.floor(Math.min(source.width, source.height)));
}

/**
 * Upper zoom bound for THIS source. A 4000px photo gets the full ×4; a 96px
 * favicon-sized logo gets ×2, because ×4 would crop it to 24 source pixels.
 */
export function maxZoom(source: Size): number {
  return clamp(maxCropSide(source) / MIN_CROP_SIDE, ZOOM_MIN, ZOOM_CEILING);
}

export function clampZoom(source: Size, zoom: number): number {
  return clamp(zoom, ZOOM_MIN, maxZoom(source));
}

/** Side of the crop square, in source pixels, at a given zoom. */
export function cropSideFor(source: Size, zoom: number): number {
  return Math.max(1, Math.round(maxCropSide(source) / clampZoom(source, zoom)));
}

/**
 * The crop square, clamped so it always lies wholly inside the source. Callers
 * hold an UNCLAMPED pan and let this clamp on read, so that dragging into a
 * corner and back out again does not lose the original position.
 */
export function cropRect(source: Size, zoom: number, pan: Point): CropRect {
  const size = cropSideFor(source, zoom);
  return {
    size,
    x: Math.round(clamp(pan.x, 0, Math.max(0, source.width - size))),
    y: Math.round(clamp(pan.y, 0, Math.max(0, source.height - size))),
  };
}

/** Where the crop starts: dead centre, which is the best guess we have. */
export function centredPan(source: Size, zoom: number): Point {
  const size = cropSideFor(source, zoom);
  return { x: (source.width - size) / 2, y: (source.height - size) / 2 };
}

/**
 * Translate a pointer drag (in on-screen viewport pixels) into a new pan.
 *
 * Dragging the image RIGHT moves the crop window LEFT over the source, which is
 * why the deltas are subtracted: the admin is grabbing the picture, not the
 * window onto it. `viewportPx` converts between the two spaces, so the same
 * gesture covers the same fraction of the photo at any display size.
 */
export function panAfterDrag(
  source: Size,
  zoom: number,
  pan: Point,
  drag: Point,
  viewportPx: number,
): Point {
  if (!(viewportPx > 0)) return pan;
  const perPixel = cropSideFor(source, zoom) / viewportPx;
  return { x: pan.x - drag.x * perPixel, y: pan.y - drag.y * perPixel };
}

/**
 * Re-anchor the pan when the zoom changes, so the crop grows and shrinks about
 * its own centre. Without this, zooming in walks the subject towards the
 * top-left — you centre a face, zoom, and it slides out of frame.
 */
export function panForZoom(source: Size, zoom: number, pan: Point, nextZoom: number): Point {
  const current = cropRect(source, zoom, pan);
  const nextSize = cropSideFor(source, nextZoom);
  return {
    x: current.x + current.size / 2 - nextSize / 2,
    y: current.y + current.size / 2 - nextSize / 2,
  };
}

/**
 * Edge of the written image. Capped at MAX_OUTPUT_EDGE and never larger than
 * the crop itself: enlarging a 200px crop to 1200px would add no detail and
 * quadruple the bytes, so a small crop stays small.
 */
export function outputEdge(cropSize: number): number {
  return Math.max(1, Math.min(Math.round(cropSize), MAX_OUTPUT_EDGE));
}

export type OutputFormat = {
  mime: "image/png" | "image/jpeg";
  ext: "png" | "jpg";
  /** Undefined for PNG, which is lossless and ignores the argument. */
  quality?: number;
};

/**
 * PNG in, PNG out — a stable logo with a transparent background re-encoded as
 * JPEG comes back with the transparency flattened, which is the one case where
 * "just make it a JPEG" visibly damages the asset. Everything else becomes
 * JPEG, which is what makes the size cap worth having.
 *
 * The chosen extension is the one the upload path must use. It has to describe
 * the BYTES, not the file the admin picked: ENG-766's marketing copy derives
 * the public object's key and content type from this extension, so a .png key
 * holding JPEG bytes would publish a mislabelled object to the public origin.
 */
export function outputFormat(sourceType: string | undefined): OutputFormat {
  return sourceType === "image/png"
    ? { mime: "image/png", ext: "png" }
    : { mime: "image/jpeg", ext: "jpg", quality: JPEG_QUALITY };
}
