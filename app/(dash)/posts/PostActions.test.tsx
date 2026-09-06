// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import PostActions from "./PostActions";
import ToastRegion, { resetToastsForTest } from "../Toast";

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
  resetToastsForTest();
  vi.clearAllMocks();
});

// The real tree: PostActions raises toasts, and the ONE <ToastRegion/> that
// renders them lives in the (dash) layout — not in the row. Every test below
// mounts that shape, so nothing here can pass against a per-row region.
function renderRow(ui: ReactElement) {
  return render(
    <>
      {ui}
      <ToastRegion />
    </>,
  );
}

function assertiveRegion() {
  return document.querySelector('[aria-live="assertive"]') as HTMLElement;
}
function politeRegion() {
  return document.querySelector('[aria-live="polite"]') as HTMLElement;
}

describe("PostActions — happy path per status", () => {
  it("Unpublish on a published post calls unpublishPost, shows a success toast, and refreshes", async () => {
    unpublishPost.mockResolvedValueOnce(undefined);
    renderRow(<PostActions id="p1" status="published" />);
    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    await screen.findByText("Post unpublished — members can no longer see it.");
    expect(unpublishPost).toHaveBeenCalledWith("p1");
    expect(within(politeRegion()).getByText("Post unpublished — members can no longer see it.")).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it("Republish on an unpublished post calls republishPost, shows a success toast, and refreshes", async () => {
    republishPost.mockResolvedValueOnce(undefined);
    renderRow(<PostActions id="p2" status="unpublished" />);
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
      renderRow(<PostActions id="p3" status={status} />);
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
    renderRow(<PostActions id="p4" status="draft" />);
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
    renderRow(<PostActions id="p5" status="published" />);
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
    renderRow(<PostActions id="p6" status="draft" />);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(discardDraft).not.toHaveBeenCalled();
    expect(screen.queryByTestId("adm-toast")).toBeNull();
    confirmSpy.mockRestore();
  });
});

describe("PostActions — optimistic row state", () => {
  it("swaps Unpublish for Republish after a successful unpublish, without any re-render from the parent", async () => {
    unpublishPost.mockResolvedValueOnce(undefined);
    renderRow(<PostActions id="p7" status="published" />);
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
    renderRow(<PostActions id="p8" status="published" />);
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
    const { container } = renderRow(<PostActions id="p9" status="draft" />);
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

describe("PostActions — exactly one live-region pair per page", () => {
  // The regression this guards: <ToastRegion/> used to be rendered INSIDE
  // PostActions, i.e. once per table row. A 20-row posts page therefore carried
  // 40 permanently-mounted live regions and 20 `position: fixed` stacks at the
  // same coordinates — so the PR's own repro (unpublish one row, publish
  // another that 409s) still painted two toasts on top of each other, because
  // they belonged to two different rows.
  const ROWS = 20;

  it(`mounts one polite region, one assertive region and one stack for a ${ROWS}-row table`, () => {
    render(
      <table>
        <tbody>
          {Array.from({ length: ROWS }, (_, i) => (
            <tr key={i}>
              <td className="actions">
                <PostActions id={`p${i}`} status="published" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>,
    );
    // The rows really are all there — otherwise the counts below are vacuous.
    expect(screen.getAllByRole("button", { name: "Unpublish" })).toHaveLength(ROWS);
    // ...and the layout mounts the single region alongside them.
    render(<ToastRegion />);
    expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
    expect(document.querySelectorAll('[aria-live="assertive"]')).toHaveLength(1);
    expect(document.querySelectorAll(".adm-toast-stack")).toHaveLength(1);
  });

  it("shows a success from one row and a failure from another in the SAME stack — the repro the ticket names", async () => {
    unpublishPost.mockResolvedValueOnce(undefined);
    publishNow.mockRejectedValueOnce(new Error("Publish failed (409)."));
    render(
      <>
        <PostActions id="row-a" status="published" />
        <PostActions id="row-b" status="draft" />
        <ToastRegion />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    fireEvent.click(screen.getByRole("button", { name: "Publish now" }));
    await screen.findByText("Post unpublished — members can no longer see it.");
    await screen.findByText("Publish failed (409).");

    const stacks = document.querySelectorAll(".adm-toast-stack");
    expect(stacks).toHaveLength(1);
    // Both toasts are alive at once, and both are inside that one stack — so
    // they lay out as a column instead of overlapping.
    const toasts = screen.getAllByTestId("adm-toast");
    expect(toasts).toHaveLength(2);
    toasts.forEach((t) => expect(stacks[0].contains(t)).toBe(true));
  });
});

describe("PostActions — the optimistic overlay follows the server", () => {
  // Mutation guard: deleting the `seenStatus` reset block in PostActions must
  // turn this red. Without it the overlay shadows the `status` prop for the
  // life of the component, so a row re-rendered with a genuinely new status —
  // someone else republished while this instance was mounted — keeps showing
  // the stale affordance forever.
  it("drops the overlay when the parent re-renders with a different status", async () => {
    unpublishPost.mockResolvedValueOnce(undefined);
    const { rerender } = renderRow(<PostActions id="p10" status="published" />);
    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    // Overlay adopted: the row shows the optimistic "unpublished" affordance
    // even though the prop still says "published".
    await screen.findByRole("button", { name: "Republish" });

    // The server now reports a THIRD state — not the one the overlay stands in
    // for, and not the one it was mounted with.
    rerender(
      <>
        <PostActions id="p10" status="draft" />
        <ToastRegion />
      </>,
    );
    expect(screen.getByRole("button", { name: "Publish now" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Republish" })).toBeNull();
  });

  it("keeps the overlay while the server keeps sending the SAME status it stood in for", async () => {
    unpublishPost.mockResolvedValueOnce(undefined);
    const { rerender } = renderRow(<PostActions id="p11" status="published" />);
    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    await screen.findByRole("button", { name: "Republish" });
    // A refresh that has not yet picked up the write must not flip the row back
    // to "Unpublish" — that is the double-click bug the overlay exists for.
    rerender(
      <>
        <PostActions id="p11" status="published" />
        <ToastRegion />
      </>,
    );
    expect(screen.getByRole("button", { name: "Republish" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Unpublish" })).toBeNull();
  });
});
