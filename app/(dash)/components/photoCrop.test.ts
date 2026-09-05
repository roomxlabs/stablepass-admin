import { describe, expect, it } from "vitest";
import {
  MAX_OUTPUT_EDGE,
  MIN_CROP_SIDE,
  ZOOM_CEILING,
  ZOOM_FILL,
  centredPan,
  clampZoom,
  cropRect,
  cropSideFor,
  drawPlacement,
  fitCropSide,
  maxCropSide,
  maxZoom,
  minZoom,
  outputEdge,
  outputFormat,
  panAfterDrag,
  panBounds,
  panForZoom,
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

  it("ENG-980: zooming out reaches minZoom, where the whole source is in frame", () => {
    // The old floor pinned every source to ZOOM_FILL (its shorter edge); the
    // fix lets a landscape or portrait photo zoom out further, to its longer
    // edge, so the whole thing — not just a full-height slice — is reachable.
    expect(clampZoom(WIDE, 0.2)).toBe(minZoom(WIDE));
    expect(minZoom(WIDE)).toBeLessThan(ZOOM_FILL);
    expect(clampZoom(WIDE, -5)).toBe(minZoom(WIDE));
    expect(clampZoom(WIDE, 99)).toBe(ZOOM_CEILING);
  });

  it("falls back to the minimum for a non-finite zoom", () => {
    expect(clampZoom(WIDE, Number.NaN)).toBe(minZoom(WIDE));
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

  it("clamps the rect wholly inside the source, so output never has empty edges", () => {
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

  it("a square source has no slack to pan at zoom 1 (already fully visible)...", () => {
    expect(cropRect(SQUARE, 1, { x: 500, y: 500 })).toEqual({ x: 0, y: 0, size: 800 });
  });

  it("...but DOES have slack once zoomed in, same as any other source", () => {
    // minZoom(SQUARE) === 1 only means "nothing more to reveal by zooming
    // OUT" — it must not also mean "cannot pan", which was the old bug's
    // sibling: a square source zoomed in still crops less than the whole
    // photo, so there is somewhere to drag.
    const rect = cropRect(SQUARE, 2, { x: 500, y: 500 });
    expect(rect.size).toBe(400);
    expect(rect.x).toBeGreaterThan(0);
    expect(rect.y).toBeGreaterThan(0);
  });
});

describe("fitCropSide / minZoom (ENG-980)", () => {
  it("minZoom is fit-to-frame for a source larger than the frame in either dimension", () => {
    for (const source of [WIDE, TALL]) {
      expect(cropSideFor(source, minZoom(source))).toBe(fitCropSide(source));
      expect(fitCropSide(source)).toBe(Math.max(source.width, source.height));
    }
  });

  it("at minZoom the whole source is inside the crop rect — nothing left off-frame", () => {
    for (const source of [WIDE, TALL, SQUARE, TINY]) {
      const z = minZoom(source);
      const rect = cropRect(source, z, centredPan(source, z));
      expect(rect.x).toBeLessThanOrEqual(0);
      expect(rect.y).toBeLessThanOrEqual(0);
      expect(rect.x + rect.size).toBeGreaterThanOrEqual(source.width);
      expect(rect.y + rect.size).toBeGreaterThanOrEqual(source.height);
    }
  });

  it("a square's minZoom is 1 — it is already entirely visible at ZOOM_FILL", () => {
    expect(minZoom(SQUARE)).toBe(ZOOM_FILL);
  });
});

describe("panBounds", () => {
  it("runs 0 -> dim-size when the square is smaller than the source (the window moves)", () => {
    expect(panBounds(2000, 800)).toEqual({ lo: 0, hi: 1200 });
  });

  it("runs dim-size -> 0 when the square is larger than the source (the photo moves)", () => {
    expect(panBounds(2000, 4000)).toEqual({ lo: -2000, hi: 0 });
  });

  it("collapses to a single point when the square exactly fills the source", () => {
    expect(panBounds(800, 800)).toEqual({ lo: 0, hi: 0 });
  });
});

describe("panning past the edge snaps back (ENG-980 call item 4)", () => {
  it("a wildly out-of-range pan lands exactly on a bound, on every axis and every source", () => {
    for (const source of [WIDE, TALL, SQUARE, TINY]) {
      for (const zoom of [minZoom(source), ZOOM_FILL, 2, maxZoom(source)]) {
        const size = cropSideFor(source, zoom);
        const xBounds = panBounds(source.width, size);
        const yBounds = panBounds(source.height, size);

        const farNeg = cropRect(source, zoom, { x: -999999, y: -999999 });
        expect(farNeg.x).toBe(xBounds.lo);
        expect(farNeg.y).toBe(yBounds.lo);

        const farPos = cropRect(source, zoom, { x: 999999, y: 999999 });
        expect(farPos.x).toBe(xBounds.hi);
        expect(farPos.y).toBe(yBounds.hi);
      }
    }
  });

  it("at minZoom the source can never be dragged to leave a gap on the flush axis", () => {
    // WIDE's crop size at minZoom is its WIDTH (4000), so x is flush — the
    // source's left/right edges always exactly meet the frame, whatever the
    // pan, and only y (the padded axis) ever moves.
    for (const pan of [
      { x: -9999, y: -9999 },
      { x: 9999, y: 9999 },
      { x: 500, y: 0 },
    ]) {
      const rect = cropRect(WIDE, minZoom(WIDE), pan);
      expect(rect.x).toBe(0);
      expect(rect.x + rect.size).toBeGreaterThanOrEqual(WIDE.width);
    }
  });
});

describe("drawPlacement (ENG-980)", () => {
  it("maps a fully-inside crop 1:1, with no offset and no letterboxing", () => {
    const rect = { x: 1000, y: 0, size: 2000 };
    const placement = drawPlacement(WIDE, rect, 1200);
    expect(placement).toEqual({
      sx: 1000,
      sy: 0,
      sw: 2000,
      sh: 2000,
      dx: 0,
      dy: 0,
      dw: 1200,
      dh: 1200,
    });
  });

  it("letterboxes a zoomed-out crop: the whole source draws inset on the padded axis", () => {
    const z = minZoom(WIDE); // fitCropSide(WIDE) = 4000, so the crop is {x:0,y:-1000,size:4000}
    const rect = cropRect(WIDE, z, centredPan(WIDE, z));
    const placement = drawPlacement(WIDE, rect, 1200);
    expect(placement).not.toBeNull();
    expect(placement!.sx).toBe(0);
    expect(placement!.sy).toBe(0);
    expect(placement!.sw).toBe(4000);
    expect(placement!.sh).toBe(2000);
    expect(placement!.dx).toBe(0);
    expect(placement!.dy).toBeGreaterThan(0);
    expect(placement!.dh).toBeLessThan(1200);
  });

  it("returns null when the rect does not intersect the source at all", () => {
    const rect = { x: 5000, y: 5000, size: 200 };
    expect(drawPlacement(WIDE, rect, 1200)).toBeNull();
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

  it("holds the no-upscale invariant across every source and zoom, including the new sub-1 zooms", () => {
    // ENG-980: minZoom(WIDE)/minZoom(TALL) are below 1, so this sweep now
    // covers the padded, zoomed-out crops too — the case outputEdge had never
    // been exercised against before.
    for (const source of [WIDE, TALL, SQUARE, TINY]) {
      for (const zoom of [minZoom(source), ZOOM_FILL, 2, maxZoom(source)]) {
        const rect = cropRect(source, zoom, centredPan(source, zoom));
        expect(outputEdge(cropSideFor(source, zoom))).toBeLessThanOrEqual(cropSideFor(source, zoom));
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
