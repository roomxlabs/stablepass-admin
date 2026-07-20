// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import PostAnalytics from "./PostAnalytics";
import type { PostAnalytics as PostAnalyticsData } from "@/lib/analytics/queries";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: { children: React.ReactNode; href: string } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function data(over: Partial<PostAnalyticsData> = {}): PostAnalyticsData {
  return {
    post: {
      id: "pa1",
      title: "Last fast gallop before Saturday",
      horseName: "Mahogany",
      trainerName: "Chris Waller",
      type: "video",
      publishedAt: "2026-07-16T20:05:00.000Z",
    },
    opensByDay: [
      { day: "2026-07-16", opens: 312 },
      { day: "2026-07-17", opens: 148 },
    ],
    reactionsByEmoji: [
      { emoji: "👍", count: 58 },
      { emoji: "❤️", count: 39 },
    ],
    saves: 28,
    opens: 598,
    reach: 204,
    ...over,
  };
}

afterEach(cleanup);

describe("PostAnalytics", () => {
  it("renders the four tiles", () => {
    render(<PostAnalytics data={data()} />);
    expect(screen.getByTestId("post-tiles").children).toHaveLength(4);
    expect(screen.getByText("598")).toBeTruthy();
    expect(screen.getByText("204")).toBeTruthy();
  });

  it("totals reactions from whatever emoji the API returned", () => {
    render(<PostAnalytics data={data()} />);
    // 58 + 39 = 97 — computed, not a hardcoded reaction set.
    expect(screen.getByText("97")).toBeTruthy();
  });

  it("renders an arbitrary emoji set without a hardcoded allowlist", () => {
    render(
      <PostAnalytics
        data={data({ reactionsByEmoji: [{ emoji: "🦄", count: 4 }, { emoji: "🎺", count: 2 }] })}
      />,
    );
    expect(screen.getByText("🦄")).toBeTruthy();
    expect(screen.getByText("🎺")).toBeTruthy();
  });

  it("shows the saves-as-share-of-opens delta", () => {
    render(<PostAnalytics data={data()} />);
    expect(screen.getByText("4.7% of opens")).toBeTruthy();
  });

  it("links back to the analytics screen", () => {
    render(<PostAnalytics data={data()} />);
    expect(screen.getByRole("link", { name: /Analytics/ }).getAttribute("href")).toBe("/analytics");
  });

  it("renders empty states when the post has no engagement yet", () => {
    render(<PostAnalytics data={data({ opensByDay: [], reactionsByEmoji: [], opens: 0, saves: 0 })} />);
    expect(screen.getByText("No opens recorded for this post yet.")).toBeTruthy();
    expect(screen.getByText("No reactions on this post yet.")).toBeTruthy();
    // A zero-open post must not render NaN% in the saves tile.
    expect(screen.getByText("no opens yet")).toBeTruthy();
  });

  it("handles an unpublished post without rendering Invalid Date", () => {
    render(<PostAnalytics data={data({ post: { ...data().post, publishedAt: null } })} />);
    expect(screen.getByText(/Not published/)).toBeTruthy();
  });
});
