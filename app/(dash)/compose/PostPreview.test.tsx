// @vitest-environment jsdom
// ENG-558 — the preview box must show the ratio a MEMBER will get, and say so
// out loud. Before this, every asset was previewed in a fixed 16:9 frame with a
// blind centre crop, so an operator uploading a 9:16 reel had no way to tell.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import PostPreview, { MediaReadout, type PostPreviewData } from "./PostPreview";
import {
  ASPECT_DEFAULT,
  ASPECT_MAX,
  ASPECT_MIN,
  describeOrientation,
  resolveAspect,
} from "./types";

afterEach(cleanup);

function data(over: Partial<PostPreviewData> = {}): PostPreviewData {
  return {
    horseName: "Mahogany",
    byline: "Chris Waller",
    caption: "Last gallop before Saturday.",
    mediaType: null,
    mediaUrl: null,
    dimensions: null,
    ...over,
  };
}

function mediaBox() {
  return screen.getByTestId("post-preview-media");
}

describe("resolveAspect", () => {
  it("passes a ratio inside the member range straight through", () => {
    expect(resolveAspect({ width: 1920, height: 1080 })).toBeCloseTo(1.7778, 4);
    expect(resolveAspect({ width: 1000, height: 1000 })).toBe(1);
  });

  it("clamps past the portrait and landscape limits", () => {
    // A 9:16 reel: members get 4:5, not the full 0.5625.
    expect(resolveAspect({ width: 1080, height: 1920 })).toBe(ASPECT_MIN);
    expect(resolveAspect({ width: 1080, height: 1920 })).toBe(0.8);
    // 2.35:1 cinema scope clamps to 1.91:1.
    expect(resolveAspect({ width: 2350, height: 1000 })).toBe(ASPECT_MAX);
    expect(resolveAspect({ width: 2350, height: 1000 })).toBe(1.91);
  });

  it("is total — unknown or nonsense dimensions fall back to 16:10", () => {
    expect(resolveAspect(null)).toBe(ASPECT_DEFAULT);
    expect(resolveAspect(null)).toBe(1.6);
    expect(resolveAspect({ width: 0, height: 1080 })).toBe(1.6);
    expect(resolveAspect({ width: 1920, height: 0 })).toBe(1.6);
    expect(resolveAspect({ width: -1920, height: -1080 })).toBe(1.6);
    expect(resolveAspect({ width: Number.NaN, height: 1080 })).toBe(1.6);
  });
});

describe("describeOrientation", () => {
  it("names a landscape video and promises the ratio members get", () => {
    expect(describeOrientation({ width: 1920, height: 1080 }, "video")).toBe(
      "1920×1080 · Landscape 16:9 · Members see it at 16:9",
    );
  });

  it("says CROPPED when the asset is outside the member range", () => {
    // The case the operator currently cannot see at all.
    expect(describeOrientation({ width: 1080, height: 1920 }, "video")).toBe(
      "1080×1920 · Portrait 9:16 · Members see it cropped to 4:5",
    );
    expect(describeOrientation({ width: 2350, height: 1000 }, "video")).toBe(
      "2350×1000 · Landscape 2.35:1 · Members see it cropped to 1.91:1",
    );
  });

  it("names a square video", () => {
    expect(describeOrientation({ width: 1080, height: 1080 }, "video")).toBe(
      "1080×1080 · Square 1:1 · Members see it at 1:1",
    );
  });

  it("tells the truth about photos: measured, but members get 16:10", () => {
    // Photos are Storage assets with no Mux aspect_ratio, so the app renders
    // them at the default whatever we measured. Never promise 16:9 here.
    expect(describeOrientation({ width: 1920, height: 1080 }, "photo")).toBe(
      "1920×1080 · Landscape 16:9 · Members see it at 16:10",
    );
    expect(describeOrientation({ width: 1080, height: 1920 }, "photo")).toBe(
      "1080×1920 · Portrait 9:16 · Members see it at 16:10",
    );
  });

  it("falls back to 16:10 when the file could not be measured", () => {
    expect(describeOrientation(null, "video")).toBe(
      "Dimensions unavailable · Members see it at 16:10",
    );
    expect(describeOrientation({ width: 0, height: 0 }, "photo")).toBe(
      "Dimensions unavailable · Members see it at 16:10",
    );
  });
});

describe("PostPreview media box", () => {
  it("holds the 16:10 default before anything is measured", () => {
    render(<PostPreview data={data()} />);
    expect(mediaBox().style.aspectRatio).toBe("1.6");
    expect(screen.getByText("Media preview")).toBeTruthy();
  });

  it("takes the asset's real ratio once measured", () => {
    render(
      <PostPreview
        data={data({ mediaType: "video", mediaUrl: "blob:x", dimensions: { width: 1920, height: 1080 } })}
      />,
    );
    expect(Number(mediaBox().style.aspectRatio)).toBeCloseTo(1.7778, 4);
  });

  it("clamps a 9:16 reel to 4:5 rather than letterboxing or over-cropping", () => {
    render(
      <PostPreview
        data={data({ mediaType: "video", mediaUrl: "blob:x", dimensions: { width: 1080, height: 1920 } })}
      />,
    );
    expect(mediaBox().style.aspectRatio).toBe("0.8");
  });

  it("renders a photo at the 16:10 members get, not at what it measured", () => {
    // A 4:5 box here would promise framing the app cannot deliver: photos have
    // no Mux aspect_ratio, so every one of them lands on the default.
    render(
      <PostPreview
        data={data({ mediaType: "photo", mediaUrl: "blob:x", dimensions: { width: 1080, height: 1920 } })}
      />,
    );
    expect(mediaBox().style.aspectRatio).toBe("1.6");
  });

  it("guardrail: bakes no watermark into the admin preview", () => {
    // The stablepass mark is a member-side display-time overlay. "Improving"
    // preview fidelity by rendering it here would misrepresent the stored
    // asset, so pin it: the only image in the card is the asset itself.
    const { container } = render(
      <PostPreview
        data={data({ mediaType: "photo", mediaUrl: "blob:x", dimensions: { width: 1600, height: 1000 } })}
      />,
    );
    expect(container.querySelector('[class*="watermark"]')).toBeNull();
    expect(container.querySelector('[data-testid*="watermark"]')).toBeNull();
    expect(container.querySelector('img[src*="watermark"]')).toBeNull();
    expect(container.querySelectorAll("img")).toHaveLength(1);
  });
});

// Vitest stubs CSS modules, so a rendered component cannot prove what the
// stylesheet says. Read the stylesheet itself: without this, all four
// card-parity acceptance criteria can be reverted with the suite still green.
describe("member-card parity (compose.module.css)", () => {
  // Resolved from the repo root: under Vitest `import.meta.url` is not a file: URL.
  const css = readFileSync(join(process.cwd(), "app/(dash)/compose/compose.module.css"), "utf8");

  function ruleBlock(selector: string): string {
    const start = css.indexOf(`\n${selector} {`);
    expect(start, `${selector} not found`).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf("\n}", start));
  }

  it("the preview card has no border and no radius", () => {
    const card = ruleBlock(".postCard");
    expect(card).not.toMatch(/border/);
    expect(card).toMatch(/max-width:\s*560px/); // the centred pane stays
  });

  it("the horse name is on the sans stack", () => {
    expect(ruleBlock(".postHorse")).toMatch(/font-family:\s*var\(--font-sans\)/);
  });

  it("no brand green behind unpainted media, and 16:10 is the fallback box", () => {
    const media = ruleBlock(".postMedia");
    expect(media).not.toMatch(/brand-green/);
    expect(media).toMatch(/background:\s*var\(--ink\)/);
    expect(media).toMatch(/aspect-ratio:\s*16\/10/);
  });

  it("the rail preview is aspect-driven, not a fixed letterbox", () => {
    const mini = ruleBlock(".miniMedia");
    expect(mini).toMatch(/aspect-ratio:\s*16\/10/);
    expect(mini).not.toMatch(/height:/);
  });
});

describe("MediaReadout", () => {
  it("renders nothing until an asset is on screen to describe", () => {
    const { container } = render(
      <MediaReadout mediaType={null} mediaUrl={null} dimensions={null} measured={false} />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("media-readout")).toBeNull();
  });

  it("asserts no orientation while metadata is still loading", () => {
    render(<MediaReadout mediaType="video" mediaUrl="blob:x" dimensions={null} measured={false} />);
    const line = screen.getByTestId("media-readout");
    expect(line.textContent).toBe("Measuring…");
    expect(line.textContent).not.toMatch(/Landscape|Portrait|Square/);
  });

  it("says dimensions are unavailable when the browser cannot decode the file", () => {
    render(<MediaReadout mediaType="video" mediaUrl="blob:x" dimensions={null} measured />);
    expect(screen.getByTestId("media-readout").textContent).toBe(
      "Dimensions unavailable · Members see it at 16:10",
    );
  });

  it("prints the detected orientation once measured", () => {
    render(
      <MediaReadout
        mediaType="video"
        mediaUrl="blob:x"
        dimensions={{ width: 1080, height: 1920 }}
        measured
      />,
    );
    expect(screen.getByTestId("media-readout").textContent).toBe(
      "1080×1920 · Portrait 9:16 · Members see it cropped to 4:5",
    );
  });
});
