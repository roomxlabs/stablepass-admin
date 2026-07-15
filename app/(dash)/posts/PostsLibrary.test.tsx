// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import PostsLibrary from "./PostsLibrary";
import type { PostView, StatusCounts } from "./types";

// next/link → plain anchor; next/navigation + the network layer are stubbed so
// PostActions renders inertly (we only assert which affordances appear).
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push }),
}));
vi.mock("./api", () => ({
  unpublishPost: vi.fn(),
  republishPost: vi.fn(),
  publishNow: vi.fn(),
  discardDraft: vi.fn(),
}));

// Run `fn` with process.env.TZ pinned — Node re-reads TZ on assignment (tzset +
// V8 date-cache notification), so this proves browser-TZ rendering the same way
// LocalTime.test.tsx does. Perth is UTC+8, Jakarta UTC+7 (neither observes DST).
function withTZ<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}
const PERTH = "Australia/Perth"; // UTC+8
const JAKARTA = "Asia/Jakarta"; // UTC+7

// An instant `daysAhead` in the future at a given UTC hour. <LocalTime> reads the
// real `now`, so a scheduled row must be genuinely future (and within 7 days) to
// take the weekday branch — computing it relative to now keeps the suite stable.
function futureUTC(daysAhead: number, utcHour: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(utcHour, 0, 0, 0);
  return d.toISOString();
}

function view(over: Partial<PostView>): PostView {
  return {
    id: "p",
    editHref: `/compose?id=${over.id ?? "p"}`,
    title: "Track gallop",
    excerpt: "Morning at Caulfield.",
    horseName: "Mahogany",
    trainerName: "Chris Waller",
    thumbUrl: null,
    typeLabel: "Video",
    status: "published",
    statusLabel: "Published",
    statusPillClass: "pill green dot",
    publishedAt: "2026-07-13T00:00:00Z",
    scheduledFor: null,
    likeCount: 42,
    ...over,
  };
}

// One row of each status so the action logic is exercised across the board.
const posts: PostView[] = [
  view({ id: "pub", status: "published", statusLabel: "Published", statusPillClass: "pill green dot" }),
  view({ id: "sch", status: "scheduled", statusLabel: "Scheduled", statusPillClass: "pill amber dot", likeCount: null, publishedAt: null, scheduledFor: futureUTC(2, 12) }),
  view({ id: "dft", status: "draft", statusLabel: "Draft", statusPillClass: "pill", likeCount: null, publishedAt: null, scheduledFor: null }),
  view({ id: "unp", status: "unpublished", statusLabel: "Unpublished", statusPillClass: "pill red dot" }),
];
const counts: StatusCounts = { all: 4, published: 1, scheduled: 1, draft: 1, unpublished: 1 };

function renderLib() {
  return render(
    <PostsLibrary
      posts={posts}
      status="all"
      counts={counts}
      q=""
      total={4}
      offset={0}
      limit={20}
      hasMore={false}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PostsLibrary", () => {
  it("renders the five status filter chips and both search inputs", () => {
    renderLib();
    for (const label of ["All", "Published", "Scheduled", "Drafts", "Unpublished"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByLabelText("Search posts")).toBeTruthy();
    expect(screen.getByLabelText("Filter posts by horse or trainer")).toBeTruthy();
  });

  it("shows Discard only on drafts", () => {
    renderLib();
    // Exactly one draft row → exactly one Discard affordance, and none elsewhere.
    expect(screen.getAllByRole("button", { name: "Discard" })).toHaveLength(1);
  });

  it("toggles Unpublish (published) ↔ Republish (unpublished), Publish now on scheduled + drafts", () => {
    renderLib();
    expect(screen.getAllByRole("button", { name: "Unpublish" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Republish" })).toHaveLength(1);
    // One scheduled row + one draft row → two Publish now affordances (the
    // publish endpoint accepts both statuses).
    expect(screen.getAllByRole("button", { name: "Publish now" })).toHaveLength(2);
  });

  it("clicking a row opens the post detail (Compose in edit mode)", () => {
    renderLib();
    fireEvent.click(screen.getAllByText("Track gallop")[0]);
    expect(push).toHaveBeenCalledWith("/compose?id=pub");
  });

  it("clicking a row action does NOT navigate away", () => {
    renderLib();
    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    expect(push).not.toHaveBeenCalled();
  });

  it("no per-row Edit link remains (the row itself replaced it)", () => {
    renderLib();
    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
  });

  it("renders the N-of-M pagination footer", () => {
    renderLib();
    expect(screen.getByText(/Showing 4 of 4 posts/)).toBeTruthy();
  });

  it("renders the empty state when there are no posts", () => {
    render(
      <PostsLibrary
        posts={[]}
        status="all"
        counts={{ all: 0, published: 0, scheduled: 0, draft: 0, unpublished: 0 }}
        q=""
        total={0}
        offset={0}
        limit={20}
        hasMore={false}
      />,
    );
    expect(screen.getByText("No posts yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  });
});

// Render a single-row library so the Published cell's <time> is unambiguous.
function renderOne(over: Partial<PostView>) {
  return render(
    <PostsLibrary
      posts={[view(over)]}
      status="all"
      counts={{ all: 1, published: 0, scheduled: 0, draft: 0, unpublished: 0 }}
      q=""
      total={1}
      offset={0}
      limit={20}
      hasMore={false}
    />,
  );
}

const sched = (scheduledFor: string): Partial<PostView> => ({
  id: "sch",
  status: "scheduled",
  statusLabel: "Scheduled",
  statusPillClass: "pill amber dot",
  likeCount: null,
  publishedAt: null,
  scheduledFor,
});

// 24-hour wall-clock of `iso` in `tz` — the locale-independent proof of the
// "20:00 / 19:00" acceptance numbers.
const wallClock24 = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }).format(
    new Date(iso),
  );

describe("PostsLibrary — Published column renders in the browser TZ (via LocalTime)", () => {
  // 12:00 UTC → 20:00 Perth (UTC+8) / 19:00 Jakarta (UTC+7). Future & within 7
  // days → LocalTime's weekday branch, which carries a wall-clock time.
  const scheduledFor = futureUTC(2, 12);

  it("a scheduled post stored at 12:00+00 shows 20:00 wall-clock under TZ=Australia/Perth", () => {
    const { container } = withTZ(PERTH, () => renderOne(sched(scheduledFor)));
    const t = container.querySelector("time")!;
    // Wired through <LocalTime>: machine-readable instant + browser-TZ label.
    expect(t.getAttribute("datetime")).toBe(scheduledFor);
    expect(t.textContent).toBe(
      withTZ(PERTH, () =>
        new Date(scheduledFor).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }),
      ),
    );
    // …and that browser-TZ wall clock is Perth-local (20:00), not UTC (12:00).
    expect(wallClock24(scheduledFor, PERTH)).toBe("20:00");
    // Locale-independent DOM proof of the acceptance number: the rendered label
    // carries the Perth wall clock — 20:00 (24-h locale) or 8:00 (12-h locale) —
    // never 12:00 (UTC) or 19:00/7:00 (Jakarta).
    expect(t.textContent).toMatch(/\b(20:00|8:00)\b/);
  });

  it("the same instant shows 19:00 under TZ=Asia/Jakarta — a one-hour, browser-driven shift", () => {
    const perth = withTZ(PERTH, () => renderOne(sched(scheduledFor)).container.querySelector("time")!.textContent);
    cleanup();
    const jakarta = withTZ(JAKARTA, () =>
      renderOne(sched(scheduledFor)).container.querySelector("time")!.textContent,
    );
    // Different wall-clock per TZ → the label reflects the operator's browser, not the server.
    expect(perth).not.toBe(jakarta);
    expect(wallClock24(scheduledFor, JAKARTA)).toBe("19:00");
    // The Jakarta-rendered label carries the Jakarta wall clock: 19:00 or 7:00.
    expect(jakarta).toMatch(/\b(19:00|7:00)\b/);
  });

  it("a draft row shows the em-dash placeholder and no <time> (identical to today)", () => {
    const { container } = renderOne({
      id: "dft",
      status: "draft",
      statusLabel: "Draft",
      statusPillClass: "pill",
      likeCount: null,
      publishedAt: null,
      scheduledFor: null,
    });
    expect(container.querySelector("time")).toBeNull();
    expect(container.textContent).toContain("—");
  });

  it("a published post renders its published_at instant via <time dateTime=…>", () => {
    const publishedAt = "2026-07-10T09:30:00Z";
    const { container } = renderOne({ id: "pub", status: "published", publishedAt, scheduledFor: null });
    expect(container.querySelector("time")!.getAttribute("datetime")).toBe(publishedAt);
  });
});
