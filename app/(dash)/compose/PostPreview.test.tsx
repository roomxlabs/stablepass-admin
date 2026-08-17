// @vitest-environment jsdom
// Render cover for the honest compose preview (ENG-558). The shipped preview
// claimed to show "exactly what a subscriber will see" while hardcoding a race
// badge, omitting the reaction bar, putting the caption in the wrong place and
// cropping every reel to 16:9. These tests pin each of those.
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import PostPreview, { type PostPreviewData } from "./PostPreview";
import PreviewModal from "./PreviewModal";
import type { MeasureState, MediaDimensions } from "./types";

afterEach(cleanup);

const BASE: PostPreviewData = {
  horseName: "Mahogany",
  byline: "Chris Waller",
  caption: "Last fast gallop before Saturday.",
  mediaType: "video",
  mediaUrl: "blob:local-file",
  racesToday: false,
  dims: null,
  measure: "off",
};

function renderPreview(over: Partial<PostPreviewData> = {}) {
  return render(<PostPreview data={{ ...BASE, ...over }} />);
}

/** Mirrors ComposeScreen's ownership of the measurement, so the test drives
 *  the real loop: element reports its size -> state -> re-render. */
function MeasuringHarness({ mediaUrl, mediaType }: { mediaUrl: string; mediaType: "video" | "photo" }) {
  const [dims, setDims] = useState<MediaDimensions>(null);
  const [measure, setMeasure] = useState<MeasureState>("measuring");
  return (
    <PostPreview
      data={{ ...BASE, mediaUrl, mediaType, dims, measure }}
      onMeasure={(d) => {
        setMeasure("done");
        setDims(d);
      }}
    />
  );
}

describe("the race badge is conditional", () => {
  it("is absent for a horse with no race today", () => {
    renderPreview({ racesToday: false });
    expect(screen.queryByTestId("preview-race-badge")).toBeNull();
  });

  it("is present for a horse that races today", () => {
    renderPreview({ racesToday: true });
    expect(screen.getByTestId("preview-race-badge").textContent).toBe("Race day");
  });
});

describe("member-card anatomy", () => {
  it("renders a reaction bar and a bookmark", () => {
    renderPreview();
    expect(screen.getByTestId("preview-reactions")).toBeTruthy();
    expect(screen.getByTestId("preview-bookmark")).toBeTruthy();
  });

  it("renders them non-interactive — no control, no handler", () => {
    renderPreview();
    const bar = screen.getByTestId("preview-reactions");
    // No button/link/input anywhere inside, nothing focusable, no click handler.
    expect(bar.querySelector("button, a, input, [role='button']")).toBeNull();
    expect(bar.querySelector("[tabindex]")).toBeNull();
    expect(bar.getAttribute("aria-hidden")).toBe("true");
    for (const el of [bar, screen.getByTestId("preview-bookmark")]) {
      expect((el as HTMLElement).onclick).toBeNull();
    }
  });

  it("puts the caption BELOW the reaction bar", () => {
    renderPreview();
    const bar = screen.getByTestId("preview-reactions");
    const caption = screen.getByTestId("preview-caption");
    // DOCUMENT_POSITION_FOLLOWING (4) = caption comes after the bar.
    expect(bar.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("title-cases an ALL-CAPS racing name, as members see it", () => {
    renderPreview({ horseName: "CANNONBROOK (AUS)" });
    expect(screen.getByText("Cannonbrook (AUS)")).toBeTruthy();
  });
});

describe("the media box tells the truth about aspect", () => {
  it("sits at the 16:10 fallback and asserts no orientation before metadata", () => {
    renderPreview({ dims: null, measure: "measuring" });
    expect(screen.getByTestId("preview-media").style.aspectRatio).toBe("1.6");
    const readout = screen.getByTestId("preview-readout").textContent ?? "";
    expect(readout).toBe("Measuring…");
    expect(readout).not.toMatch(/Landscape|Portrait|Square/);
  });

  it("announces the readout, which changes without the operator acting", () => {
    // "Measuring…" -> the result happens on its own, so a screen-reader user
    // gets nothing unless the node is a live region.
    render(<MeasuringHarness mediaUrl="blob:reel" mediaType="video" />);
    expect(screen.getByTestId("preview-readout")).toBe(screen.getByRole("status"));

    const video = screen.getByTestId("preview-video") as HTMLVideoElement;
    Object.defineProperty(video, "videoWidth", { value: 1080, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 1920, configurable: true });
    fireEvent.loadedMetadata(video);
    // Same node after the transition — not swapped out, so the region is live.
    expect(screen.getByRole("status").textContent).toContain("Portrait");
  });

  it("clamps a 1080x1920 reel to 0.8 and says it will be cropped", () => {
    render(<MeasuringHarness mediaUrl="blob:reel" mediaType="video" />);
    const video = screen.getByTestId("preview-video") as HTMLVideoElement;
    Object.defineProperty(video, "videoWidth", { value: 1080, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 1920, configurable: true });
    fireEvent.loadedMetadata(video);

    expect(screen.getByTestId("preview-media").style.aspectRatio).toBe("0.8");
    expect(screen.getByTestId("preview-readout").textContent).toBe(
      "1080×1920 · Portrait 9:16 · Members see it cropped to 4:5",
    );
  });

  it("previews a landscape video uncropped at its own ratio", () => {
    render(<MeasuringHarness mediaUrl="blob:landscape" mediaType="video" />);
    const video = screen.getByTestId("preview-video") as HTMLVideoElement;
    Object.defineProperty(video, "videoWidth", { value: 1920, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 1080, configurable: true });
    fireEvent.loadedMetadata(video);

    expect(Number(screen.getByTestId("preview-media").style.aspectRatio)).toBeCloseTo(1.7778, 3);
    expect(screen.getByTestId("preview-readout").textContent).toBe(
      "1920×1080 · Landscape 16:9 · Members see it at 16:9",
    );
  });

  it("measures a photo, promises the app's 16:10 box, AND draws that box", () => {
    render(<MeasuringHarness mediaUrl="blob:photo" mediaType="photo" />);
    const img = screen.getByTestId("preview-img") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: 1600, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 900, configurable: true });
    fireEvent.load(img);

    expect(screen.getByTestId("preview-readout").textContent).toBe(
      "1600×900 · Landscape 16:9 · Members see it cropped to 16:10",
    );
    // The box MUST agree with that sentence. Asserting only the readout is how
    // a preview that contradicts its own caption ships.
    expect(screen.getByTestId("preview-media").style.aspectRatio).toBe("1.6");
  });

  it("draws a portrait photo at 16:10 too, not at its own ratio", () => {
    render(<MeasuringHarness mediaUrl="blob:tallphoto" mediaType="photo" />);
    const img = screen.getByTestId("preview-img") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: 1080, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 1920, configurable: true });
    fireEvent.load(img);

    expect(screen.getByTestId("preview-media").style.aspectRatio).toBe("1.6");
    expect(screen.getByTestId("preview-readout").textContent).toContain("cropped to 16:10");
  });

  it("says so, and never blocks, when the file cannot be decoded", () => {
    render(<MeasuringHarness mediaUrl="blob:corrupt" mediaType="video" />);
    fireEvent.error(screen.getByTestId("preview-video"));
    expect(screen.getByTestId("preview-readout").textContent).toBe(
      "Dimensions unavailable · Members see it at 16:10",
    );
  });

  it("clears the previous readout when the operator swaps the file", () => {
    const { rerender } = render(
      <PostPreview data={{ ...BASE, measure: "done", dims: { width: 1920, height: 1080 } }} />,
    );
    expect(screen.getByTestId("preview-readout").textContent).toContain("Landscape");

    // ComposeScreen nulls dims and re-enters "measuring" on the new pick.
    rerender(
      <PostPreview
        data={{ ...BASE, mediaUrl: "blob:next", dims: null, measure: "measuring" }}
      />,
    );
    const readout = screen.getByTestId("preview-readout").textContent ?? "";
    expect(readout).toBe("Measuring…");
    expect(readout).not.toContain("1920×1080");
  });

  it("shows the empty block at 16:10 with no readout when no file is chosen", () => {
    renderPreview({ mediaUrl: null, mediaType: null, measure: "off" });
    expect(screen.queryByTestId("preview-readout")).toBeNull();
    expect(screen.getByTestId("preview-media").style.aspectRatio).toBe("1.6");
    expect(screen.getByText("Media preview")).toBeTruthy();
  });

  it("prints NO dimensions in edit mode, where the source is an HLS rendition", () => {
    // hls.js starts on a low-bitrate rendition, so videoWidth/videoHeight
    // describe the rendition, not the asset. Silence beats a wrong number.
    renderPreview({ mediaUrl: "https://stream.example/x.m3u8?token=t", measure: "off" });
    expect(screen.queryByTestId("preview-readout")).toBeNull();
  });
});

describe("the modal is ONE honest pane", () => {
  it("renders exactly one card and no mobile/web pane switch", () => {
    render(<PreviewModal open onClose={() => {}} data={BASE} />);

    expect(screen.getAllByTestId("post-preview")).toHaveLength(1);
    // The old switch: labels "Mobile"/"Web" over two device frames.
    expect(screen.queryByText("Mobile")).toBeNull();
    expect(screen.queryByText("Web")).toBeNull();
    expect(screen.queryByText(/mobile & web/i)).toBeNull();
    expect(screen.queryByText("app.stablepass.co")).toBeNull();
  });

  it("says in words what web does differently instead of faking a pane", () => {
    render(<PreviewModal open onClose={() => {}} data={BASE} />);
    expect(
      screen.getByText("This is the member card. Web renders the same content in a wider column."),
    ).toBeTruthy();
  });
});

describe("guardrail: no watermarking in admin", () => {
  it("bakes no stablepass overlay into the preview", () => {
    const { container } = renderPreview({ racesToday: true });
    // The overlay is applied member-side at display time. If a future change
    // adds one here it must fail this test, not ship quietly.
    expect(container.querySelector("[class*='watermark' i]")).toBeNull();
    expect(container.querySelector("[data-testid*='watermark' i]")).toBeNull();
    expect(container.innerHTML.toLowerCase()).not.toContain("watermark");
  });
});
