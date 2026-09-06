// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import DashboardLoading from "./loading";
import PostsLoading from "./posts/loading";
import HorsesLoading from "./horses/loading";
import TrainersLoading from "./trainers/loading";
import AnalyticsLoading from "./analytics/loading";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

const routes = [
  // The group fallback stands in for forms too, so it deliberately has no
  // route-specific title — see app/(dash)/loading.tsx.
  { name: "Loading…", Component: DashboardLoading, label: "Loading" },
  { name: "Posts", Component: PostsLoading, label: "Loading the posts library" },
  { name: "Horses", Component: HorsesLoading, label: "Loading horses" },
  { name: "Trainers", Component: TrainersLoading, label: "Loading trainers" },
  { name: "Analytics", Component: AnalyticsLoading, label: "Loading analytics" },
];

describe.each(routes)("$name loading", ({ name, Component, label }) => {
  it("renders the real title so the heading does not flicker when the page swaps in", () => {
    render(<Component />);
    expect(screen.getByRole("heading", { name })).toBeTruthy();
  });

  it("carries aria-busy on the root", () => {
    const { getByTestId } = render(<Component />);
    expect(getByTestId("route-skeleton").getAttribute("aria-busy")).toBe("true");
  });

  it("mounts the status node EMPTY and writes the label in a LATER commit — a live region that arrives together with its text is never announced", () => {
    // `loading.tsx` is what the SERVER streams while the page renders, so the
    // server markup is literally the first thing the browser mounts. If the
    // label were rendered inline (`<p role="status">{label}</p>`) it would be
    // in that markup, and the region would gain its content in the same commit
    // as the region itself — which no assistive technology announces.
    //
    // Asserting only `textContent === label` after a client render (as this
    // suite originally did) is true of the broken form too: delete the effect,
    // inline the label, and nothing goes red. The mount ORDER is the property
    // that matters, so it is the property asserted.
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<Component />);
    const streamed = host.querySelector('[role="status"]');
    expect(streamed, "the status node must be in the streamed markup").not.toBeNull();
    expect(streamed!.textContent, "the label must NOT be in the first commit").toBe("");

    // Then the effect writes it — a real mutation of an already-observed node.
    render(<Component />);
    expect(screen.getByRole("status").textContent).toBe(label);
  });

  it("announces exactly one status node with the route's label, and hides the skeleton bars from the a11y tree", () => {
    const { container } = render(<Component />);
    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(1);
    expect(statuses[0].textContent).toBe(label);

    const bars = container.querySelectorAll(".sk");
    expect(bars.length).toBeGreaterThan(0);
    bars.forEach((bar) => {
      expect(bar.closest('[aria-hidden="true"]')).not.toBeNull();
    });
  });
});

describe("Horses loading — grid, not table", () => {
  it("renders the card grid skeleton and no table skeleton", () => {
    const { container } = render(<HorsesLoading />);
    expect(container.querySelector(".sk-grid")).not.toBeNull();
    expect(container.querySelector(".sk-card")).toBeNull();
  });
});

describe("Stat tile counts", () => {
  it("analytics renders 5 stat tiles", () => {
    const { container } = render(<AnalyticsLoading />);
    expect(container.querySelectorAll(".sk-stat")).toHaveLength(5);
  });

  it("dashboard renders 4 stat tiles", () => {
    const { container } = render(<DashboardLoading />);
    expect(container.querySelectorAll(".sk-stat")).toHaveLength(4);
  });
});
