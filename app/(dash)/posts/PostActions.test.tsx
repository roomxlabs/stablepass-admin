// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import PostActions from "./PostActions";

const refresh = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push }),
}));

const unpublishPost = vi.fn();
const republishPost = vi.fn();
const publishNow = vi.fn();
const discardDraft = vi.fn();
const deletePost = vi.fn();
vi.mock("./api", () => ({
  unpublishPost: (...args: unknown[]) => unpublishPost(...args),
  republishPost: (...args: unknown[]) => republishPost(...args),
  publishNow: (...args: unknown[]) => publishNow(...args),
  discardDraft: (...args: unknown[]) => discardDraft(...args),
  deletePost: (...args: unknown[]) => deletePost(...args),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function assertiveRegion() {
  return document.querySelector('[aria-live="assertive"]') as HTMLElement;
}
function politeRegion() {
  return document.querySelector('[aria-live="polite"]') as HTMLElement;
}

describe("PostActions — happy path per status", () => {
  it("Unpublish on a published post calls unpublishPost, shows a success toast, and refreshes", async () => {
    unpublishPost.mockResolvedValueOnce(undefined);
    render(<PostActions id="p1" status="published" />);
    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    await screen.findByText("Post unpublished — members can no longer see it.");
    expect(unpublishPost).toHaveBeenCalledWith("p1");
    expect(within(politeRegion()).getByText("Post unpublished — members can no longer see it.")).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it("Republish on an unpublished post calls republishPost, shows a success toast, and refreshes", async () => {
    republishPost.mockResolvedValueOnce(undefined);
    render(<PostActions id="p2" status="unpublished" />);
    fireEvent.click(screen.getByRole("button", { name: "Republish" }));
    await screen.findByText("Post republished — it's live for members again.");
    expect(republishPost).toHaveBeenCalledWith("p2");
    expect(within(politeRegion()).getByText("Post republished — it's live for members again.")).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it.each<["scheduled" | "draft"]>([["scheduled"], ["draft"]])(
    "Publish now on a %s post calls publishNow, shows a success toast, and refreshes",
    async (status) => {
      publishNow.mockResolvedValueOnce(undefined);
      render(<PostActions id="p3" status={status} />);
      fireEvent.click(screen.getByRole("button", { name: "Publish now" }));
      await screen.findByText("Post published.");
      expect(publishNow).toHaveBeenCalledWith("p3");
      expect(within(politeRegion()).getByText("Post published.")).toBeTruthy();
      expect(refresh).toHaveBeenCalled();
    },
  );

  it("Discard on a draft confirms, calls discardDraft, shows a success toast, and refreshes", async () => {
    discardDraft.mockResolvedValueOnce(undefined);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PostActions id="p4" status="draft" />);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await screen.findByText("Draft discarded.");
    expect(confirmSpy).toHaveBeenCalled();
    expect(discardDraft).toHaveBeenCalledWith("p4");
    expect(within(politeRegion()).getByText("Draft discarded.")).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("Delete on a non-draft post confirms, calls deletePost, shows a success toast, and refreshes", async () => {
    deletePost.mockResolvedValueOnce(undefined);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PostActions id="p5" status="published" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByText("Post permanently deleted.");
    expect(confirmSpy).toHaveBeenCalled();
    expect(deletePost).toHaveBeenCalledWith("p5");
    expect(within(politeRegion()).getByText("Post permanently deleted.")).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});

describe("PostActions — cancelling the confirm", () => {
  it("calls neither the api fn nor shows any toast when confirm is cancelled", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<PostActions id="p6" status="draft" />);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(discardDraft).not.toHaveBeenCalled();
    expect(screen.queryByTestId("adm-toast")).toBeNull();
    confirmSpy.mockRestore();
  });
});

describe("PostActions — optimistic row state", () => {
  it("swaps Unpublish for Republish after a successful unpublish, without any re-render from the parent", async () => {
    unpublishPost.mockResolvedValueOnce(undefined);
    render(<PostActions id="p7" status="published" />);
    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    // The parent never re-rendered with a new `status` prop — this proves the
    // component holds its own optimistic overlay rather than relying on the
    // parent to have already refreshed.
    await screen.findByRole("button", { name: "Republish" });
    expect(screen.queryByRole("button", { name: "Unpublish" })).toBeNull();
  });

  it("removes all action buttons after a successful delete", async () => {
    deletePost.mockResolvedValueOnce(undefined);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PostActions id="p8" status="published" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByText("Post permanently deleted.");
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unpublish" })).toBeNull();
    confirmSpy.mockRestore();
  });
});

describe("PostActions — failure", () => {
  it("shows the error message in the assertive region, does not refresh, and does not adopt the optimistic status", async () => {
    publishNow.mockRejectedValueOnce(new Error("Publish failed (409)."));
    const { container } = render(<PostActions id="p9" status="draft" />);
    fireEvent.click(screen.getByRole("button", { name: "Publish now" }));
    await screen.findByText("Publish failed (409).");
    expect(within(assertiveRegion()).getByText("Publish failed (409).")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
    // Losing the race must not show the post as published — the button still
    // reads "Publish now" (see ENG-950: the publish route re-asserts its
    // precondition on the UPDATE itself).
    expect(screen.getByRole("button", { name: "Publish now" })).toBeTruthy();
    expect(container.querySelector(".row-err")).toBeNull();
  });
});
