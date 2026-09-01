import { describe, expect, it } from "vitest";
import {
  MAX_OUTPUT_EDGE,
  MIN_CROP_SIDE,
  ZOOM_CEILING,
  ZOOM_MIN,
  centredPan,
  clampZoom,
  cropRect,
  cropSideFor,
  maxCropSide,
  maxZoom,
  outputEdge,
  outputFormat,
  panAfterDrag,
  panForZoom,
  fitZoom,
  needsFill,
  placement,
} from "./photoCrop";

// ENG-749 — the crop maths. Pure by design, so these are real tests rather than
// assertions against a mock: every number here is one the shipped code computes.

const WIDE = { width: 4000, height: 2000 }; // a landscape photo, the whole point
const TALL = { width: 900, height: 1600 }; // a phone portrait
const SQUARE = { width: 800, height: 800 };
const TINY = { width: 120, height: 90 }; // smaller than any viewport

describe("maxCropSide", () => {
  it("is the shorter edge, so the square always fits inside the source", () => {
    expect(maxCropSide(WIDE)).toBe(2000);
    expect(maxCropSide(TALL)).toBe(900);
    expect(maxCropSide(SQUARE)).toBe(800);
  });

  it("floors a fractional size rather than rounding past the edge", () => {
    expect(maxCropSide({ width: 100.9, height: 200 })).toBe(100);
  });
});

describe("zoom bounds", () => {
  it("caps a large source at the ceiling", () => {
    expect(maxZoom(WIDE)).toBe(ZOOM_CEILING);
  });

  it("gives a small source a smaller ceiling, so a crop never gets absurd", () => {
    // 90px shorter edge / 48px floor = 1.875, well under the ×4 ceiling.
    expect(maxZoom(TINY)).toBeCloseTo(90 / MIN_CROP_SIDE, 5);
    expect(cropSideFor(TINY, maxZoom(TINY))).toBe(MIN_CROP_SIDE);
  });

  // REVERSED, 1 Sep 2026 (Justin: "It only lets me make them larger not
  // smaller"): the floor is now fitZoom — the whole photo just fits — and the
  // old "never past 1" rule is retired. Everything below the new floor still
  // clamps.
  it("allows zooming out to the whole-photo fit, and no further", () => {
    // WIDE is 4000×2000: fit = 2000/4000 = 0.5.
    expect(fitZoom(WIDE)).toBe(0.5);
    expect(clampZoom(WIDE, 0.7)).toBe(0.7);
    expect(clampZoom(WIDE, 0.2)).toBe(0.5);
    expect(clampZoom(WIDE, -5)).toBe(0.5);
    expect(clampZoom(WIDE, 99)).toBe(ZOOM_CEILING);
  });

  it("offers a square source no zoom-out at all — fit IS 1 there", () => {
    expect(fitZoom(SQUARE)).toBe(ZOOM_MIN);
    expect(clampZoom(SQUARE, 0.3)).toBe(ZOOM_MIN);
  });

  it("falls back to the floor for a non-finite zoom", () => {
    expect(clampZoom(WIDE, Number.NaN)).toBe(fitZoom(WIDE));
  });
});

describe("cropSideFor", () => {
  it("shows the whole shorter edge at zoom 1", () => {
    expect(cropSideFor(WIDE, 1)).toBe(2000);
    expect(cropSideFor(TALL, 1)).toBe(900);
  });

  it("halves the crop at zoom 2", () => {
    expect(cropSideFor(WIDE, 2)).toBe(1000);
  });
});

describe("cropRect", () => {
  it("centres a wide photo's square by default — the old behaviour, as the start point", () => {
    const rect = cropRect(WIDE, 1, centredPan(WIDE, 1));
    expect(rect).toEqual({ x: 1000, y: 0, size: 2000 });
  });

  it("centres a tall photo's square by default", () => {
    const rect = cropRect(TALL, 1, centredPan(TALL, 1));
    expect(rect).toEqual({ x: 0, y: 350, size: 900 });
  });

  it("lets the crop reach the far left — the subject-off-centre case this ticket exists for", () => {
    const rect = cropRect(WIDE, 1, { x: 0, y: 0 });
    expect(rect).toEqual({ x: 0, y: 0, size: 2000 });
  });

  // Scoped to zoom >= 1 since sub-fit zoom exists: BELOW 1 the square may
  // exceed the source by design, and the renderer paints the surround (see the
  // placement/needsFill cases below — "the square is always fully painted" is
  // the invariant now, not "the rect is inside the source").
  it("clamps the rect wholly inside the source at zoom >= 1", () => {
    for (const source of [WIDE, TALL, SQUARE, TINY]) {
      for (const zoom of [1, 1.5, 2, maxZoom(source)]) {
        for (const pan of [
          { x: -9999, y: -9999 },
          { x: 9999, y: 9999 },
          centredPan(source, zoom),
        ]) {
          const rect = cropRect(source, zoom, pan);
          expect(rect.x).toBeGreaterThanOrEqual(0);
          expect(rect.y).toBeGreaterThanOrEqual(0);
          expect(rect.x + rect.size).toBeLessThanOrEqual(source.width);
          expect(rect.y + rect.size).toBeLessThanOrEqual(source.height);
        }
      }
    }
  });

  it("gives a square source no slack to pan at zoom 1", () => {
    expect(cropRect(SQUARE, 1, { x: 500, y: 500 })).toEqual({ x: 0, y: 0, size: 800 });
  });

  // ── sub-fit zoom (1 Sep 2026) ──────────────────────────────────────────────
  it("centres per axis below fit on that axis, and pan has no say there", () => {
    // WIDE at fit (0.5): the 4000px square centres the 2000px-tall photo
    // vertically; horizontally it fits exactly.
    const rect = cropRect(WIDE, fitZoom(WIDE), { x: 9999, y: -9999 });
    expect(rect).toEqual({ x: 0, y: -1000, size: 4000 });
  });

  it("keeps the still-cropping axis pannable at a zoom between fit and 1", () => {
    // WIDE at 0.8: side = 2500 — taller than the photo (centres, y = -250)
    // but narrower than its width (pans, clamped into [0, 1500]).
    const rect = cropRect(WIDE, 0.8, { x: 9999, y: 0 });
    expect(rect).toEqual({ x: 1500, y: -250, size: 2500 });
    expect(cropRect(WIDE, 0.8, { x: -50, y: 0 }).x).toBe(0);
  });
});

describe("placement + needsFill — the fill contract", () => {
  it("maps the sharp layer wholly inside the source, at every zoom", () => {
    for (const source of [WIDE, TALL, SQUARE, TINY]) {
      for (const zoom of [fitZoom(source), 0.8, 1, 2]) {
        const rect = cropRect(source, zoom, centredPan(source, zoom));
        const put = placement(source, rect, outputEdge(rect.size));
        expect(put.sx).toBeGreaterThanOrEqual(0);
        expect(put.sy).toBeGreaterThanOrEqual(0);
        expect(put.sx + put.sw).toBeLessThanOrEqual(source.width);
        expect(put.sy + put.sh).toBeLessThanOrEqual(source.height);
      }
    }
  });

  it("letterboxes the whole photo, centred, at fit zoom", () => {
    const rect = cropRect(WIDE, fitZoom(WIDE), centredPan(WIDE, fitZoom(WIDE)));
    const edge = outputEdge(rect.size); // 1200 (capped)
    const put = placement(WIDE, rect, edge);
    // The full 4000×2000 source, scaled into a 1200 square: 1200×600, centred.
    expect(put).toEqual({ sx: 0, sy: 0, sw: 4000, sh: 2000, dx: 0, dy: 300, dw: 1200, dh: 600 });
  });

  it("is the identity mapping at zoom >= 1 — no fill, full-bleed sharp layer", () => {
    const rect = cropRect(WIDE, 1, centredPan(WIDE, 1));
    const edge = outputEdge(rect.size);
    const put = placement(WIDE, rect, edge);
    expect(needsFill(WIDE, rect)).toBe(false);
    expect(put.dx).toBe(0);
    expect(put.dy).toBe(0);
    expect(put.dw).toBe(edge);
    expect(put.dh).toBe(edge);
  });

  it("flags the fill exactly when the square is not fully covered", () => {
    expect(needsFill(WIDE, cropRect(WIDE, 0.8, { x: 0, y: 0 }))).toBe(true);
    expect(needsFill(SQUARE, cropRect(SQUARE, 1, { x: 0, y: 0 }))).toBe(false);
  });
});

describe("panAfterDrag", () => {
  it("moves the crop window opposite the drag — the admin grabs the photo, not the window", () => {
    // Viewport 400px shows a 2000px crop, so one screen pixel is five source px.
    const next = panAfterDrag(WIDE, 1, { x: 1000, y: 0 }, { x: 100, y: 0 }, 400);
    expect(next.x).toBe(1000 - 100 * 5);
  });

  it("covers the same fraction of the photo at any viewport size", () => {
    const small = panAfterDrag(WIDE, 1, { x: 1000, y: 0 }, { x: 50, y: 0 }, 200);
    const large = panAfterDrag(WIDE, 1, { x: 1000, y: 0 }, { x: 100, y: 0 }, 400);
    expect(small.x).toBe(large.x);
  });

  it("scales with zoom: a zoomed-in drag moves fewer source pixels", () => {
    const out = panAfterDrag(WIDE, 1, { x: 1000, y: 0 }, { x: 100, y: 0 }, 400);
    const inn = panAfterDrag(WIDE, 2, { x: 1000, y: 0 }, { x: 100, y: 0 }, 400);
    expect(1000 - inn.x).toBeLessThan(1000 - out.x);
  });

  it("keeps an unclamped pan so dragging into a corner and back does not lose position", () => {
    const pushed = panAfterDrag(WIDE, 1, { x: 0, y: 0 }, { x: 400, y: 0 }, 400);
    expect(pushed.x).toBeLessThan(0);
    // It still renders clamped...
    expect(cropRect(WIDE, 1, pushed).x).toBe(0);
    // ...and dragging back recovers, rather than starting from the clamped edge.
    const back = panAfterDrag(WIDE, 1, pushed, { x: -400, y: 0 }, 400);
    expect(back.x).toBe(0);
  });

  it("ignores a drag with no measurable viewport", () => {
    const pan = { x: 10, y: 20 };
    expect(panAfterDrag(WIDE, 1, pan, { x: 5, y: 5 }, 0)).toBe(pan);
  });
});

describe("panForZoom", () => {
  it("zooms about the crop's own centre, so a framed subject stays framed", () => {
    const start = { x: 0, y: 0 }; // hard left of a wide photo
    const before = cropRect(WIDE, 1, start);
    const centreX = before.x + before.size / 2;

    const after = cropRect(WIDE, 2, panForZoom(WIDE, 1, start, 2));
    expect(after.x + after.size / 2).toBe(centreX);
  });

  it("keeps the centre when zooming back out, where the source has room", () => {
    const at2 = centredPan(WIDE, 2);
    const before = cropRect(WIDE, 2, at2);
    const after = cropRect(WIDE, 1, panForZoom(WIDE, 2, at2, 1));
    expect(after.x + after.size / 2).toBe(before.x + before.size / 2);
  });

  it("lets the clamp win when the bigger square cannot fit around that centre", () => {
    // Framed hard left at ×2, then zoomed out: a 2000px square centred at 800
    // would start at -200, outside the photo. Staying inside the source is the
    // stronger invariant, so the centre slides right rather than the crop
    // running off the edge. Asserted so the trade-off is a decision, not a bug
    // someone re-discovers from a screenshot.
    const at2 = { x: 300, y: 400 };
    const before = cropRect(WIDE, 2, at2);
    const after = cropRect(WIDE, 1, panForZoom(WIDE, 2, at2, 1));
    expect(before.x + before.size / 2).toBe(800);
    expect(after.x).toBe(0);
    expect(after.x + after.size / 2).toBe(1000);
  });
});

describe("outputEdge", () => {
  it("caps an oversized photo, which is the upload-size fix", () => {
    expect(outputEdge(4000)).toBe(MAX_OUTPUT_EDGE);
    expect(outputEdge(2000)).toBe(MAX_OUTPUT_EDGE);
  });

  it("NEVER upscales: a small crop stays its own size", () => {
    expect(outputEdge(90)).toBe(90);
    expect(outputEdge(1199)).toBe(1199);
  });

  it("never writes a zero-edge canvas", () => {
    expect(outputEdge(0)).toBe(1);
  });

  it("holds the no-upscale invariant across every source and zoom", () => {
    for (const source of [WIDE, TALL, SQUARE, TINY]) {
      for (const zoom of [1, 2, maxZoom(source)]) {
        const rect = cropRect(source, zoom, centredPan(source, zoom));
        expect(outputEdge(rect.size)).toBeLessThanOrEqual(rect.size);
      }
    }
  });
});

describe("outputFormat", () => {
  it("keeps PNG as PNG, so a logo's transparency survives", () => {
    expect(outputFormat("image/png")).toEqual({ mime: "image/png", ext: "png" });
  });

  it("does not pass a quality for PNG, which is lossless", () => {
    expect(outputFormat("image/png").quality).toBeUndefined();
  });

  it("encodes everything else as JPEG at the ticket's quality", () => {
    expect(outputFormat("image/jpeg")).toEqual({ mime: "image/jpeg", ext: "jpg", quality: 0.9 });
    expect(outputFormat("image/webp").mime).toBe("image/jpeg");
    expect(outputFormat(undefined).mime).toBe("image/jpeg");
  });

  it("pairs every extension with the matching mime — the marketing copy keys off it", () => {
    // ENG-766 derives the PUBLIC object's key and content type from this
    // extension. A mismatch here publishes mislabelled bytes to a public origin.
    for (const type of ["image/png", "image/jpeg", "image/webp", "", undefined]) {
      const format = outputFormat(type);
      expect(format.mime).toBe(format.ext === "png" ? "image/png" : "image/jpeg");
    }
  });
});
