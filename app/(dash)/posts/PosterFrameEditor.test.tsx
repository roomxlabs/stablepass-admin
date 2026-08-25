// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import PosterFrameEditor from "./PosterFrameEditor";
import * as api from "./api";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("../compose/PosterScrubber", () => ({
  default: ({
    selectedTimeS,
    onPick,
    src,
    disabled,
  }: {
    selectedTimeS: number | null;
    onPick: (t: number) => void;
    src: string;
    disabled?: boolean;
  }) => (
    <div data-testid="poster-scrubber" data-src={src} data-selected={String(selectedTimeS)}>
      <button
        type="button"
        data-testid="poster-use-frame"
        disabled={disabled}
        onClick={() => onPick(selectedTimeS ?? 2.5)}
      >
        Use this frame
      </button>
    </div>
  ),
}));

vi.mock("./api", () => ({
  rebakePoster: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PosterFrameEditor", () => {
  it("preselects poster_time_s when opening the scrubber", () => {
    render(
      <PosterFrameEditor
        postId="p1"
        playbackUrl="https://stream.mux.com/pb.m3u8?token=t"
        posterTimeS={3.5}
      />,
    );
    fireEvent.click(screen.getByTestId("choose-preview-frame"));
    const scrubber = screen.getByTestId("poster-scrubber");
    expect(scrubber.getAttribute("data-selected")).toBe("3.5");
    expect(scrubber.getAttribute("data-src")).toContain(".m3u8");
  });

  it("Use this frame POSTs time; success updates and shows ok", async () => {
    vi.mocked(api.rebakePoster).mockResolvedValue({
      posterUrl: "posters/p1-9.jpg",
      posterTimeS: 3.5,
      posterDisplayUrl: "https://signed/posters/p1-9.jpg",
    });
    const onPosterUpdated = vi.fn();
    render(
      <PosterFrameEditor
        postId="p1"
        playbackUrl="https://stream.mux.com/pb.m3u8?token=t"
        posterTimeS={null}
        onPosterUpdated={onPosterUpdated}
      />,
    );
    fireEvent.click(screen.getByTestId("choose-preview-frame"));
    fireEvent.click(screen.getByTestId("poster-use-frame"));

    await waitFor(() => expect(api.rebakePoster).toHaveBeenCalledWith("p1", 2.5));
    await waitFor(() => expect(screen.getByTestId("poster-bake-ok")).toBeTruthy());
    expect(onPosterUpdated).toHaveBeenCalledWith("https://signed/posters/p1-9.jpg", 3.5);
  });

  it("BE failure shows error and does not call onPosterUpdated", async () => {
    vi.mocked(api.rebakePoster).mockRejectedValue(new Error("Poster re-bake failed."));
    const onPosterUpdated = vi.fn();
    render(
      <PosterFrameEditor
        postId="p1"
        playbackUrl="https://stream.mux.com/pb.m3u8?token=t"
        posterTimeS={1}
        onPosterUpdated={onPosterUpdated}
      />,
    );
    fireEvent.click(screen.getByTestId("choose-preview-frame"));
    fireEvent.click(screen.getByTestId("poster-use-frame"));

    await waitFor(() => expect(screen.getByTestId("poster-bake-err")).toBeTruthy());
    expect(onPosterUpdated).not.toHaveBeenCalled();
  });
});
