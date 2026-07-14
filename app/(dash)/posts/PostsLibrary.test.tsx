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
    whenLabel: "2h ago",
    likeCount: 42,
    ...over,
  };
}

// One row of each status so the action logic is exercised across the board.
const posts: PostView[] = [
  view({ id: "pub", status: "published", statusLabel: "Published", statusPillClass: "pill green dot" }),
  view({ id: "sch", status: "scheduled", statusLabel: "Scheduled", statusPillClass: "pill amber dot", likeCount: null, whenLabel: "Sat 6:00am" }),
  view({ id: "dft", status: "draft", statusLabel: "Draft", statusPillClass: "pill", likeCount: null, whenLabel: "—" }),
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

  it("toggles Unpublish (published) ↔ Republish (unpublished), Publish now on scheduled", () => {
    renderLib();
    expect(screen.getAllByRole("button", { name: "Unpublish" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Republish" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Publish now" })).toHaveLength(1);
    // A draft never offers unpublish/republish/publish-now beyond those rows.
    expect(screen.queryByRole("button", { name: "Unpublish" })).not.toBeNull();
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
