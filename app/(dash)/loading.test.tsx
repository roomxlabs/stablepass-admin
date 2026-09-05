// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import DashboardLoading from "./loading";
import PostsLoading from "./posts/loading";
import HorsesLoading from "./horses/loading";
import TrainersLoading from "./trainers/loading";
import AnalyticsLoading from "./analytics/loading";

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
