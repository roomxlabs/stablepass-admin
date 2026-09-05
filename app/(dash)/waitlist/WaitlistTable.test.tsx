// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import WaitlistTable, { buildExportHref, buildWaitlistHref } from "./WaitlistTable";
import type { WaitlistRow } from "./data";

// next/link renders an <a> here; the real one wants an App Router context that
// a bare RTL render has no reason to stand up.
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

afterEach(cleanup);

function row(n: number, over: Partial<WaitlistRow> = {}): WaitlistRow {
  return {
    id: `w${n}`,
    email: `person${n}@example.com`,
    source: "marketing",
    joinedAt: "2026-09-01T04:00:00.000Z",
    ...over,
  };
}

describe("<WaitlistTable>", () => {
  it("renders a row per signup, with source and a mailto", () => {
    render(<WaitlistTable rows={[row(1), row(2)]} total={2} matching={2} offset={0} limit={25} />);

    const body = screen.getAllByRole("rowgroup")[1];
    expect(within(body).getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText("person1@example.com").getAttribute("href")).toBe(
      "mailto:person1@example.com",
    );
    expect(screen.getAllByText("marketing")).toHaveLength(2);
  });

  it("shows the headline count, which is the UNFILTERED total", () => {
    // Searching narrows the table without appearing to shrink the waitlist.
    render(
      <WaitlistTable rows={[row(1)]} total={57} matching={1} q="person1" offset={0} limit={25} />,
    );

    expect(screen.getByText("Signups").textContent).toContain("57");
    expect(screen.getByText(/Matching/).textContent).toContain("1");
  });

  it("renders the empty state, and no table, when there are no signups", () => {
    render(<WaitlistTable rows={[]} total={0} matching={0} offset={0} limit={25} />);

    expect(screen.getByText(/No signups yet/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders a search-specific empty state", () => {
    render(<WaitlistTable rows={[]} total={12} matching={0} q="nobody" offset={0} limit={25} />);

    expect(screen.getByText(/No signups match/)).toBeTruthy();
  });

  it("offers the CSV export, which points at the whole-list endpoint", () => {
    render(<WaitlistTable rows={[row(1)]} total={1} matching={1} offset={0} limit={25} />);

    const link = screen.getByTestId("waitlist-export");
    expect(link.getAttribute("href")).toBe("/api/admin/waitlist/export");
    // `download` + Content-Disposition is what makes it save rather than render.
    expect(link.hasAttribute("download")).toBe(true);
  });

  it("carries the active search into the export, so it exports what is shown", () => {
    expect(buildExportHref("mel@x.com")).toBe("/api/admin/waitlist/export?q=mel%40x.com");
    expect(buildExportHref(undefined)).toBe("/api/admin/waitlist/export");
  });

  it("disables Prev on page 1 and offers Next while more rows remain", () => {
    render(
      <WaitlistTable
        rows={Array.from({ length: 25 }, (_, i) => row(i))}
        total={60}
        matching={60}
        offset={0}
        limit={25}
      />,
    );

    expect(screen.getByText("‹ Prev").className).toContain("disabled");
    expect(screen.getByText("Next ›").getAttribute("href")).toBe("/waitlist?offset=25");
    expect(screen.getByText(/Showing 25 of 60 signups/)).toBeTruthy();
  });

  it("disables Next on the last page and links Prev back", () => {
    render(
      <WaitlistTable rows={[row(1), row(2)]} total={27} matching={27} offset={25} limit={25} />,
    );

    expect(screen.getByText("Next ›").className).toContain("disabled");
    expect(screen.getByText("‹ Prev").getAttribute("href")).toBe("/waitlist");
  });

  it("does not strand the admin on a past-the-end page", () => {
    // ?offset=100 on a 28-row waitlist. Before this was fixed the screen said
    // "No signups yet" beside a headline count of 28, with no pager at all and
    // no way back except hand-editing the URL.
    render(<WaitlistTable rows={[]} total={28} matching={28} offset={100} limit={25} />);

    expect(screen.queryByText(/No signups yet/)).toBeNull();
    expect(screen.getByText(/the list ends earlier/)).toBeTruthy();
    // The pager is still there, and Prev goes back.
    expect(screen.getByText("‹ Prev").getAttribute("href")).toBe("/waitlist?offset=75");
    expect(screen.getByText("Next ›").className).toContain("disabled");
  });

  it("keeps Next inert on a last page that dropped an unusable row", () => {
    // 26 matching rows, page 2 = rows 26..26, but one had a blank address and
    // was dropped, so 0 render. `offset + rows.length < matching` would leave
    // Next live and walk the admin off the end; `offset + limit` does not.
    render(<WaitlistTable rows={[]} total={26} matching={26} offset={25} limit={25} />);

    expect(screen.getByText("Next ›").className).toContain("disabled");
  });

  it("keeps the search term while paging", () => {
    expect(buildWaitlistHref({ q: "mel", offset: 25 })).toBe("/waitlist?q=mel&offset=25");
    expect(buildWaitlistHref({ q: undefined, offset: 0 })).toBe("/waitlist");
  });
});
