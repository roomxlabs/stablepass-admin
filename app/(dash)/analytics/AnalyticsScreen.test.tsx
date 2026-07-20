// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import AnalyticsScreen from "./AnalyticsScreen";
import type { AnalyticsView } from "./data";

// next/link -> plain anchor so the toggle and row links are assertable.
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function view(over: Partial<AnalyticsView> = {}): AnalyticsView {
  return {
    period: "30d",
    tiles: [
      { label: "Subscribers", value: "348", delta: "active subscriptions" },
      { label: "On trial", value: "64", delta: "12 end within 7 days" },
      { label: "Opens", value: "9,860", delta: "first views · 30 days" },
      { label: "Reactions", value: "11,204", delta: "across all posts · 30 days" },
      { label: "Saves", value: "2,371", delta: "across all posts · 30 days" },
    ],
    opensByDay: [
      { label: "6 Jul", value: 480 },
      { label: "7 Jul", value: 940 },
    ],
    opensByHour: [
      { label: "6am", value: 820, title: "6am–8am" },
      { label: "8am", value: 300, title: "8am–10am" },
    ],
    trialsByMonth: [{ label: "Jul", value: 96 }],
    trials: [
      {
        name: "Sarah Mitchell",
        email: "sarah.m@example.test",
        startedAt: "2026-06-24T00:00:00.000Z",
        endsAt: "2026-07-24T00:00:00.000Z",
        daysLeft: 5,
        status: "trial",
      },
    ],
    trialCount: 1,
    trainers: [
      {
        trainerId: "t1",
        name: "Chris Waller",
        horses: 12,
        posts: 38,
        opens: 4120,
        reactions: 4882,
        saves: 964,
        websiteClicks: 210,
        clicks: 210,
      },
    ],
    horses: [
      {
        horseId: "h1",
        name: "Mahogany",
        trainerName: "Chris Waller",
        posts: 11,
        opens: 1682,
        reactions: 1913,
        saves: 402,
      },
    ],
    topPosts: [
      {
        postId: "pa1",
        title: "Last fast gallop before Saturday",
        horseName: "Mahogany",
        type: "video",
        opens: 598,
        reactions: 142,
        saves: 28,
      },
    ],
    ...over,
  };
}

const EMPTY = view({
  tiles: [
    { label: "Subscribers", value: "0", delta: "active subscriptions" },
    { label: "On trial", value: "0", delta: "0 end within 7 days" },
    { label: "Opens", value: "0", delta: "first views · 30 days" },
    { label: "Reactions", value: "0", delta: "across all posts · 30 days" },
    { label: "Saves", value: "0", delta: "across all posts · 30 days" },
  ],
  opensByDay: [],
  opensByHour: [],
  trialsByMonth: [],
  trials: [],
  trialCount: 0,
  trainers: [],
  horses: [],
  topPosts: [],
});

afterEach(cleanup);

describe("AnalyticsScreen — period toggle", () => {
  it("renders all three periods as ?period= links", () => {
    render(<AnalyticsScreen view={view()} />);
    const toggle = screen.getByTestId("period-toggle");
    expect(toggle.querySelectorAll("a")).toHaveLength(3);
    expect(screen.getByRole("link", { name: "7 days" }).getAttribute("href")).toBe(
      "/analytics?period=7d",
    );
    expect(screen.getByRole("link", { name: "All time" }).getAttribute("href")).toBe(
      "/analytics?period=all",
    );
  });

  it("marks only the current period active", () => {
    render(<AnalyticsScreen view={view({ period: "7d" })} />);
    expect(screen.getByRole("link", { name: "7 days" }).className).toContain("active");
    expect(screen.getByRole("link", { name: "30 days" }).className ?? "").not.toContain("active");
  });
});

describe("AnalyticsScreen — CSV link", () => {
  it("points at the trials CSV endpoint", () => {
    render(<AnalyticsScreen view={view()} />);
    const csv = screen.getByTestId("trials-csv");
    expect(csv.getAttribute("href")).toBe("/api/admin/analytics/trials?format=csv");
    expect(csv.hasAttribute("download")).toBe(true);
  });
});

describe("AnalyticsScreen — populated", () => {
  it("renders the five summary tiles", () => {
    render(<AnalyticsScreen view={view()} />);
    expect(screen.getByTestId("analytics-tiles").children).toHaveLength(5);
    expect(screen.getByText("9,860")).toBeTruthy();
  });

  it("renders the website-clicks column and the compliance note", () => {
    render(<AnalyticsScreen view={view()} />);
    expect(screen.getByText("Website clicks")).toBeTruthy();
    expect(
      screen.getByText(/counts only · per-account detail pending the compliance check/),
    ).toBeTruthy();
  });

  it("links a top-post row to its per-post page", () => {
    render(<AnalyticsScreen view={view()} />);
    expect(
      screen.getByRole("link", { name: "Last fast gallop before Saturday" }).getAttribute("href"),
    ).toBe("/analytics/posts/pa1");
  });

  it("renders charts rather than empty messages when there is data", () => {
    render(<AnalyticsScreen view={view()} />);
    expect(screen.getByTestId("opens-by-day")).toBeTruthy();
    expect(screen.getByTestId("opens-by-hour")).toBeTruthy();
    expect(screen.queryByTestId("trainers-empty")).toBeNull();
  });

  it("labels the hour-of-day chart with the timezone it renders in", () => {
    render(<AnalyticsScreen view={view()} />);
    expect(screen.getByText(/When members first see content · AEST/)).toBeTruthy();
  });
});

// Guardrail (.rx/guardrails.md + the epic decision): the trials list is the ONE
// surface allowed to carry member-identifying data. Everything else on this
// screen is aggregates. This pins that boundary against future edits.
describe("AnalyticsScreen — member PII is confined to the trials list", () => {
  it("renders no member email outside the trials table", () => {
    const { container } = render(<AnalyticsScreen view={view()} />);
    const trialsTable = screen.getByTestId("trials-table");

    const withEmail = Array.from(container.querySelectorAll("td, div, span")).filter(
      (el) => el.children.length === 0 && /@/.test(el.textContent ?? ""),
    );
    expect(withEmail.length).toBeGreaterThan(0); // the trials row itself
    for (const el of withEmail) {
      expect(trialsTable.contains(el)).toBe(true);
    }
  });

  it("renders no member identity at all when there are no trials", () => {
    const { container } = render(<AnalyticsScreen view={EMPTY} />);
    expect(container.textContent).not.toMatch(/@/);
  });

  it("keeps the engagement tables to aggregates — no member names", () => {
    render(<AnalyticsScreen view={view()} />);
    // Trainer/horse/top-post tables carry trainer, horse and post identity
    // only; the sole member name on the screen is inside the trials table.
    const trials = screen.getByTestId("trials-table");
    expect(trials.textContent).toContain("Sarah Mitchell");
    expect(screen.getByTestId("trainer-engagement").textContent).not.toContain("Sarah Mitchell");
    expect(screen.getByTestId("horse-engagement").textContent).not.toContain("Sarah Mitchell");
    expect(screen.getByTestId("top-posts").textContent).not.toContain("Sarah Mitchell");
  });
});

describe("AnalyticsScreen — empty states", () => {
  it("renders a quiet empty message in every card when all series are empty", () => {
    render(<AnalyticsScreen view={EMPTY} />);
    expect(screen.getByTestId("trainers-empty")).toBeTruthy();
    expect(screen.getByTestId("horses-empty")).toBeTruthy();
    expect(screen.getByTestId("top-posts-empty")).toBeTruthy();
    expect(screen.getByTestId("trials-empty")).toBeTruthy();
    expect(screen.getByText("No opens recorded in this period yet.")).toBeTruthy();
    expect(screen.getByText("Not enough opens yet to show a daily rhythm.")).toBeTruthy();
  });

  it("still renders the tiles and the CSV link when empty", () => {
    render(<AnalyticsScreen view={EMPTY} />);
    expect(screen.getByTestId("analytics-tiles").children).toHaveLength(5);
    expect(screen.getByTestId("trials-csv")).toBeTruthy();
  });

  it("does not render a chart svg for an empty series", () => {
    render(<AnalyticsScreen view={EMPTY} />);
    expect(screen.queryByTestId("opens-by-day")).toBeNull();
  });
});

describe("AnalyticsScreen — bar geometry", () => {
  // Regression guard for the trials-bar slab defect (ENG-276 review).
  //
  // This MUST assert at the COMPONENT level. `barLayout(series, gap)` already
  // honoured a `gap` argument before the fix, so a chart.ts-only test passes on
  // the broken code too — the defect was that no CALLER ever passed one. Only
  // the rendered `rect` width proves the caller does. Delete `gap={26}` from
  // AnalyticsScreen and this test fails.
  //
  // Nothing else guards it: `page.screenshot({ path })` OVERWRITES its baseline,
  // so the e2e specs assert nothing visual and a geometry regression would ship.
  // Peak bars render class="bar peak", which `rect.bar` already matches.
  const widthOf = (testId: string) =>
    Number(screen.getByTestId(testId).querySelector("rect.bar")?.getAttribute("width"));

  it("renders the sparse trials chart at the mockup's bar width, not a default slab", () => {
    const months = Array.from({ length: 6 }, (_, i) => ({ label: `m${i}`, value: 10 + i }));
    const days = Array.from({ length: 14 }, (_, i) => ({ label: `d${i}`, value: 10 + i }));
    render(<AnalyticsScreen view={view({ trialsByMonth: months, opensByDay: days })} />);

    // 6 buckets on the 420 viewBox: step 420/6 = 70, gap 26 -> width 44, which
    // is exactly the bar width 09-analytics.html draws. At the DEFAULT gap of 5
    // this is 65 — the reported "slab" defect. The literal 44 is a design
    // contract lifted from the mockup, so pinning it exactly is deliberate.
    expect(widthOf("trials-by-month")).toBe(44);

    // The dense chart passes no gap and so must still sit at the default. Asserted
    // as the EXPRESSION, not a literal: the mockup draws 24 here and we render 25,
    // so a literal would pin a known off-spec value and cry wolf if that 1px drift
    // is ever legitimately fixed. What this guards is "this caller opts out".
    expect(widthOf("opens-by-day")).toBe(420 / 14 - 5);
  });
});
