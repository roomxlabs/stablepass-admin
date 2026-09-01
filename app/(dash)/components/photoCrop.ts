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
//   At zoom >= 1 the rect is clamped inside the source, so the crop includes
//   no area the image does not cover. BELOW 1 (Justin, 1 Sep 2026: "It only
//   lets me make them larger not smaller. Basically every horse photo like
//   this doesn't fit in the square") the square is allowed to grow PAST the
//   source on an axis: the photo letterboxes, centred on any axis it cannot
//   fill, and the renderer paints the uncovered surround with a blurred cover
//   pass of the same photo (photoCropCanvas.ts) so the stored square is always
//   fully painted. `fitZoom` is the floor: the whole photo just fits.

/**
 * Longest edge of the written image. Also the fix for oversized uploads: a
 * 6000px phone photo lands as 1200px. Never an UPSCALE — see outputEdge.
 */
export const MAX_OUTPUT_EDGE = 1200;

export const JPEG_QUALITY = 0.9;

/**
 * Zoom 1 = "fill the square" (the classic inside-the-source crop), and it is
 * still the DEFAULT the dialog opens at. It is no longer the floor — see
 * `fitZoom` — but the name is kept because the two form suites and the e2e
 * byte-assertions are all written against the zoom-1 default.
 */
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

/**
 * The zoom at which the WHOLE photo just fits inside the square — the new
 * floor. shorter/longer collapses to 1 for a square source (no zoom-out to
 * offer), and 0.5 for a 2:1 landscape horse photo, which is exactly the case
 * the client could never fit.
 */
export function fitZoom(source: Size): number {
  const longest = Math.max(1, source.width, source.height);
  return clamp(maxCropSide(source) / longest, 0, ZOOM_MIN);
}

export function clampZoom(source: Size, zoom: number): number {
  return clamp(zoom, fitZoom(source), maxZoom(source));
}

/** Side of the crop square, in source pixels, at a given zoom. */
export function cropSideFor(source: Size, zoom: number): number {
  return Math.max(1, Math.round(maxCropSide(source) / clampZoom(source, zoom)));
}

/**
 * The crop square. Callers hold an UNCLAMPED pan and let this clamp on read,
 * so that dragging into a corner and back out again does not lose the
 * original position.
 *
 * PER AXIS: where the square fits inside the source (size <= edge) the origin
 * clamps into the source as it always did. Where it does NOT fit (sub-fit
 * zoom on that axis) the source is CENTRED — the origin goes negative and pan
 * has no say, because there is nothing to reveal by panning an axis the whole
 * photo already occupies. A 2:1 landscape at zoom 0.7 therefore still pans
 * horizontally while letterboxing vertically, which is what makes the slider
 * feel continuous through 1.0.
 */
export function cropRect(source: Size, zoom: number, pan: Point): CropRect {
  const size = cropSideFor(source, zoom);
  const axis = (p: number, edge: number) =>
    size <= edge ? Math.round(clamp(p, 0, edge - size)) : Math.round((edge - size) / 2);
  return {
    size,
    x: axis(pan.x, source.width),
    y: axis(pan.y, source.height),
  };
}

/**
 * How the SHARP photo lands inside the output square: the source-rect
 * intersection (always wholly inside the image, so drawImage never samples
 * undefined pixels) and its mapped destination rect at `edge` output pixels.
 * THE one source of truth the canvas draw and any preview math share — two
 * copies of this mapping is how a preview lies about the stored bytes.
 */
export function placement(
  source: Size,
  rect: CropRect,
  edge: number,
): { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number } {
  const scale = edge / Math.max(1, rect.size);
  const sx = Math.max(0, rect.x);
  const sy = Math.max(0, rect.y);
  const sw = Math.max(0, Math.min(source.width, rect.x + rect.size) - sx);
  const sh = Math.max(0, Math.min(source.height, rect.y + rect.size) - sy);
  return {
    sx,
    sy,
    sw,
    sh,
    dx: (sx - rect.x) * scale,
    dy: (sy - rect.y) * scale,
    dw: sw * scale,
    dh: sh * scale,
  };
}

/** True when the square is not fully covered by the photo (a fill is needed). */
export function needsFill(source: Size, rect: CropRect): boolean {
  return rect.x < 0 || rect.y < 0 || rect.x + rect.size > source.width || rect.y + rect.size > source.height;
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

/**
 * The extension for bytes that ALREADY EXIST, given their reported type.
 *
 * The caller must key the upload off this rather than off the format it asked
 * for. `HTMLCanvasElement.toBlob` is specified to fall back to `image/png` when
 * it cannot honour the requested type, so a browser that declined our JPEG
 * would hand back PNG bytes while `outputFormat` still said "jpg" — the exact
 * bytes/extension divergence this module exists to prevent, and one nothing
 * would notice because the encoder is mocked in unit tests.
 */
export function extForMime(mime: string | undefined): "png" | "jpg" {
  return mime === "image/png" ? "png" : "jpg";
}
