// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import PosterScrubber from "./PosterScrubber";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function videoFile(name = "gallop.mp4") {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "video/mp4" });
}

describe("PosterScrubber", () => {
  it("renders a local video scrubber and captures currentTime on Use this frame", () => {
    const onPick = vi.fn();
    render(
      <PosterScrubber
        file={videoFile()}
        src="blob:http://localhost/fake-video"
        selectedTimeS={null}
        onPick={onPick}
      />,
    );

    const video = screen.getByTestId("poster-scrubber-video") as HTMLVideoElement;
    // jsdom has no real decoder — stub the properties the scrubber reads.
    Object.defineProperty(video, "duration", { configurable: true, value: 12.5 });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => 3.75,
      set: vi.fn(),
    });
    fireEvent.loadedMetadata(video);

    expect(screen.getByTestId("poster-scrubber")).toBeTruthy();
    expect(screen.queryByTestId("poster-scrubber-unavailable")).toBeNull();

    fireEvent.click(screen.getByTestId("poster-use-frame"));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(3.75);
  });

  it("shows unavailable when the browser cannot decode the file, and never calls onPick", () => {
    const onPick = vi.fn();
    render(
      <PosterScrubber
        file={videoFile("raw.mov")}
        src="blob:http://localhost/hevc"
        selectedTimeS={null}
        onPick={onPick}
      />,
    );

    fireEvent.error(screen.getByTestId("poster-scrubber-video"));

    expect(screen.getByTestId("poster-scrubber-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("poster-use-frame")).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("shows the selected time after a frame has been picked", () => {
    render(
      <PosterScrubber
        file={videoFile()}
        src="blob:http://localhost/fake-video"
        selectedTimeS={4.2}
        onPick={vi.fn()}
      />,
    );
    const video = screen.getByTestId("poster-scrubber-video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 10 });
    fireEvent.loadedMetadata(video);

    expect(screen.getByTestId("poster-time-picked").textContent).toMatch(/4\.2/);
  });
});
