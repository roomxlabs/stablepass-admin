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
//   `zoom` 1 (ZOOM_FILL) means "the largest square that fits INSIDE the source",
//   i.e. the whole of the shorter edge. That is where a fresh pick starts,
//   because a full-bleed square is the right default for an avatar.
//
// ENG-980 — the square is no longer trapped inside the source.
//
//   ENG-749 also made ZOOM_FILL the hard floor, and that is the bug Mel hit on
//   the 2 Sep call. On a landscape horse photo the shorter edge is the HEIGHT,
//   so the tightest the crop could ever get was a full-height square — the ends
//   of the horse were unreachable at every zoom ("it always zooms it if that's
//   the biggest"). The floor is now `minZoom`, at which the square is the
//   source's LONGER edge and the whole photo is inside the frame, padded on the
//   short axis. Padding is the point: you cannot show all of a 2:1 photo in a
//   square without it.
//
//   Because the square may now be LARGER than the source, the clamp inverts:
//   rather than keeping the square inside the source, it keeps the source
//   inside the square. Either way the admin can never strand the photo
//   half-outside the frame — panning past the edge snaps it back (the call's
//   fourth ask).
//
//   The never-upscale rule is unchanged and still enforced in outputEdge: the
//   written edge never exceeds the crop's own source-pixel size.

/**
 * Longest edge of the written image. Also the fix for oversized uploads: a
 * 6000px phone photo lands as 1200px. Never an UPSCALE — see outputEdge.
 */
export const MAX_OUTPUT_EDGE = 1200;

export const JPEG_QUALITY = 0.9;

/**
 * The square exactly fills the frame with the source's shorter edge. Not the
 * minimum any more (see minZoom) — the starting point, and the boundary below
 * which the output gains padding.
 */
export const ZOOM_FILL = 1;

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

/** The largest square that fits INSIDE the source: its shorter edge. */
export function maxCropSide(source: Size): number {
  return Math.max(1, Math.floor(Math.min(source.width, source.height)));
}

/**
 * The smallest square that CONTAINS the source: its longer edge. This is the
 * fully-zoomed-out crop — the whole photo visible, padded on the short axis.
 */
export function fitCropSide(source: Size): number {
  return Math.max(1, Math.ceil(Math.max(source.width, source.height)));
}

/**
 * Lower zoom bound for THIS source: the point at which the whole photo is in
 * frame. It is the aspect ratio — 0.5 for a 2:1 landscape, 1 for a square,
 * which is correct, since a square is already entirely visible when it fills
 * the frame and has nothing further to reveal.
 */
export function minZoom(source: Size): number {
  const fit = maxCropSide(source) / fitCropSide(source);
  return Number.isFinite(fit) && fit > 0 ? Math.min(fit, ZOOM_FILL) : ZOOM_FILL;
}

/**
 * Upper zoom bound for THIS source. A 4000px photo gets the full ×4; a 96px
 * favicon-sized logo gets ×2, because ×4 would crop it to 24 source pixels.
 */
export function maxZoom(source: Size): number {
  return clamp(maxCropSide(source) / MIN_CROP_SIDE, ZOOM_FILL, ZOOM_CEILING);
}

export function clampZoom(source: Size, zoom: number): number {
  return clamp(zoom, minZoom(source), maxZoom(source));
}

/** Side of the crop square, in source pixels, at a given zoom. */
export function cropSideFor(source: Size, zoom: number): number {
  return Math.max(1, Math.round(maxCropSide(source) / clampZoom(source, zoom)));
}

/**
 * How far the crop's origin may travel on one axis, for a square of `size`
 * against a source edge of `dim`.
 *
 * Both orderings are one expression. When the square is SMALLER than the source
 * the origin runs 0 → dim - size (the window moves over the photo). When it is
 * LARGER the range is negative, dim - size → 0, which slides the photo around
 * inside the padded frame. In both cases the extremes are the positions where
 * the two rectangles are flush, so the source can never be dragged so far that
 * it leaves a gap it did not have to.
 */
export function panBounds(dim: number, size: number): { lo: number; hi: number } {
  const edge = dim - size;
  return { lo: Math.min(0, edge), hi: Math.max(0, edge) };
}

/**
 * The crop square, clamped so the source and the square always overlap flush.
 * Callers hold an UNCLAMPED pan and let this clamp on read, so that dragging
 * into a corner and back out again does not lose the original position.
 */
export function cropRect(source: Size, zoom: number, pan: Point): CropRect {
  const size = cropSideFor(source, zoom);
  const x = panBounds(source.width, size);
  const y = panBounds(source.height, size);
  return {
    size,
    x: Math.round(clamp(pan.x, x.lo, x.hi)),
    y: Math.round(clamp(pan.y, y.lo, y.hi)),
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
 *
 * This is also the whole of the never-upscale guarantee, and it survives the
 * ENG-980 zoom-out unchanged: the crop's size is measured in SOURCE pixels
 * whether or not the square overhangs the photo, so the written edge is still
 * bounded by real source detail.
 */
export function outputEdge(cropSize: number): number {
  return Math.max(1, Math.min(Math.round(cropSize), MAX_OUTPUT_EDGE));
}

/**
 * Where the source pixels land on the output canvas.
 *
 * Only exists because the crop may now overhang the photo. `drawImage` is
 * specified to clip an out-of-bounds source rect and scale the destination to
 * match, but browsers have disagreed about that for years, and getting it wrong
 * shows up as a stretched horse rather than a padded one. So the intersection
 * is computed here, in a pure function a test can pin, and the canvas half is
 * handed numbers that are always inside the image.
 *
 * Returns null when the two do not overlap at all, which the caller treats as
 * nothing to draw.
 */
export type DrawPlacement = {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
};

export function drawPlacement(source: Size, rect: CropRect, edge: number): DrawPlacement | null {
  if (!(rect.size > 0) || !(edge > 0)) return null;
  const scale = edge / rect.size;

  const sx = Math.max(rect.x, 0);
  const sy = Math.max(rect.y, 0);
  const sw = Math.min(rect.x + rect.size, source.width) - sx;
  const sh = Math.min(rect.y + rect.size, source.height) - sy;
  if (!(sw > 0) || !(sh > 0)) return null;

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
