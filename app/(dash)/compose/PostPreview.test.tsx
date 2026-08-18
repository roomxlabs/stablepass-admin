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
import type { MeasureState, MediaDimensions, MediaType } from "./types";
import { UPLOAD_TYPES } from "./types";

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

  // ENG-633 made the box conditional, so this is now the guard against
  // over-correcting into "hide the box whenever there is no file". A photo post
  // before the operator picks a file still gets its empty box: that box is the
  // drop target, and the member card really will have one once the asset lands.
  //
  // It used to pass `mediaType: null` to mean "no file chosen yet". That
  // spelling stopped meaning that at ENG-611 — the operator now chooses a type
  // up front, and ComposeScreen sends null only for a TEXT post (see the text
  // describe below) — so the upload-type case has to name its type.
  it("still shows the empty block at 16:10 for a photo post with no file yet", () => {
    renderPreview({ mediaUrl: null, mediaType: "photo", measure: "off" });
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

// ENG-633. A text post's title and body ARE the post — the member card runs
// header -> reactions -> body with no media box at all. The preview drew one
// anyway and captioned it "Media preview", promising the operator an anatomy no
// subscriber will ever see. That is the same class of lie A1 deleted the fake
// web pane to remove, on the one type whose card differs most.
describe("a text post gets no media box", () => {
  it("renders neither the box nor the placeholder", () => {
    renderPreview({ mediaType: "text", mediaUrl: null });
    expect(screen.queryByTestId("preview-media")).toBeNull();
    expect(screen.queryByText("Media preview")).toBeNull();
  });

  it("renders no box for the null type either, which is what ComposeScreen actually sends", () => {
    // ComposeScreen's previewData maps a text post to `mediaType: null`, not
    // "text", because a text post has no type that carries media. Guarding on
    // the "text" literal alone would pass its own test and leave the real
    // screen showing the phantom box, so the null spelling is pinned too.
    renderPreview({ mediaType: null, mediaUrl: null });
    expect(screen.queryByTestId("preview-media")).toBeNull();
    expect(screen.queryByText("Media preview")).toBeNull();
  });

  it("suppresses the orientation readout even with a measurement still in state", () => {
    // describeOrientation has nothing to describe on a post with no asset.
    // These dims are the leftover from a file picked BEFORE the operator
    // switched to Text: printing them would describe media this post no longer
    // has. ComposeScreen does clear `measure` on a type change, but the preview
    // must not need it to stay honest.
    renderPreview({
      mediaType: "text",
      mediaUrl: null,
      dims: { width: 1920, height: 1080 },
      measure: "done",
    });
    expect(screen.queryByTestId("preview-readout")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/Landscape|Portrait|Square|Members see it/)).toBeNull();
  });

  it("still renders the rest of the card — badge, name, byline, reactions, body", () => {
    // Removing the box must not quietly remove anything else with it.
    renderPreview({ mediaType: "text", mediaUrl: null, racesToday: true });
    expect(screen.getByTestId("preview-race-badge").textContent).toBe("Race day");
    expect(screen.getByText("Mahogany")).toBeTruthy();
    expect(screen.getByText("Chris Waller")).toBeTruthy();
    expect(screen.getByTestId("preview-reactions")).toBeTruthy();
    expect(screen.getByTestId("preview-bookmark")).toBeTruthy();
    expect(screen.getByTestId("preview-caption").textContent).toBe(
      "Last fast gallop before Saturday.",
    );
  });

  // Deliberately asserts the BOX, not the "Media preview" copy. That copy is
  // right for video and photo (pinned above), but the member card renders a
  // voice post as an inline player, not a black frame — so asserting the copy
  // for voice here would cement a placeholder that is itself a known fidelity
  // question, and a later voice ticket would read it as a settled decision.
  // Out of ENG-633's scope either way: what this test owes the ticket is that
  // all three keep their box.
  it("gives no box to a type that is neither an upload type nor text", () => {
    // The guard is MEMBERSHIP in UPLOAD_TYPES, not `!== "text"`. post.type's
    // CHECK still permits `news`, and page.tsx casts a loaded row's type
    // straight to MediaType, so a negative guard would wave a fifth type
    // through into a box it has no asset for. Nothing authors `news` today
    // (page.tsx filters on EDITABLE_TYPES first), so this pins the REASONING
    // rather than a live path — swap the component to `!== "text"` and only
    // this test fails.
    renderPreview({ mediaType: "news" as MediaType, mediaUrl: null });
    expect(screen.queryByTestId("preview-media")).toBeNull();
  });

  it("keeps the box for every type that DOES carry an asset, file picked or not", () => {
    // Driven off UPLOAD_TYPES itself rather than a fresh literal, so a fifth
    // post type cannot diverge the component's list from this one.
    for (const type of UPLOAD_TYPES) {
      renderPreview({ mediaType: type, mediaUrl: null, measure: "off" });
      expect(screen.getByTestId("preview-media")).toBeTruthy();
      cleanup();
    }
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

    // Name-based checks only catch an overlay that admits what it is. Pin the
    // SHAPE too: the media box holds exactly the one media element, so any
    // extra painted layer — however it is named — fails here.
    const media = screen.getByTestId("preview-media");
    expect(media.children).toHaveLength(1);
    expect(media.firstElementChild?.tagName).toBe("VIDEO");

    // And with no file it is the empty block alone, not an overlay host.
    // Spelled `photo` since ENG-633: a type that carries an asset is the case
    // that still HAS a box to keep clean. (A text post has no box at all now,
    // which is covered in its own describe.)
    cleanup();
    const empty = renderPreview({ mediaUrl: null, mediaType: "photo" }).container;
    const emptyMedia = empty.querySelector("[data-testid='preview-media']");
    expect(emptyMedia).not.toBeNull();
    expect(emptyMedia?.children).toHaveLength(1);
  });

  // ENG-633 introduced a render path with NO media box at all. The shape checks
  // above are anchored on the box, so they see nothing on that path: without
  // this test a text post could grow a baked-in overlay with the whole suite
  // green. Cover the boxless branch by name, in both its spellings.
  it("bakes none into the boxless text render either", () => {
    for (const mediaType of ["text", null] as const) {
      const { container } = renderPreview({ mediaType, mediaUrl: null, racesToday: true });
      expect(screen.queryByTestId("preview-media")).toBeNull();
      expect(container.querySelector("[class*='watermark' i]")).toBeNull();
      expect(container.querySelector("[data-testid*='watermark' i]")).toBeNull();
      expect(container.innerHTML.toLowerCase()).not.toContain("watermark");

      // Name checks only catch an overlay that admits what it is, so pin the
      // SHAPE of the boxless card too — exactly header, reaction bar, body.
      // Without this an UNNAMED painted layer could sit on the one render path
      // that has no media box to anchor the box-shape check above.
      const card = screen.getByTestId("post-preview");
      expect(card.children).toHaveLength(3);
      expect([...card.children].map((c) => c.getAttribute("data-testid"))).toEqual([
        null, // <header>, which carries no testid
        "preview-reactions",
        "preview-caption",
      ]);
      cleanup();
    }
  });
});
