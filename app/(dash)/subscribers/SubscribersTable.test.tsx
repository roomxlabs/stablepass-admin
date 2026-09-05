// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import SubscribersTable, {
  bandById,
  buildExportHref,
  buildSubscribersHref,
  statusPill,
  TENURE_BANDS,
} from "./SubscribersTable";
import type { SubscriberRow } from "./data";

// next/link renders an <a> here; the real one wants an App Router context that
// a bare RTL render has no reason to stand up.
vi.mock("next/link", () => ({
  default: ({ href, children, className, ...rest }: {
    href: string;
    children: ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(cleanup);

function row(n: number, over: Partial<SubscriberRow> = {}): SubscriberRow {
  return {
    id: `s${n}`,
    name: `Member ${n}`,
    email: `member${n}@example.com`,
    status: "active",
    startedAt: "2026-03-01T00:00:00.000Z",
    currentPeriodEnd: "2026-10-01T00:00:00.000Z",
    canceledAt: null,
    tenureMonths: 6,
    ...over,
  };
}

const cancelled = (n: number) =>
  row(n, {
    status: "canceled",
    canceledAt: "2026-09-02T00:00:00.000Z",
    tenureMonths: 4,
  });

describe("<SubscribersTable>", () => {
  it("renders a row per subscriber, with name and a mailto", () => {
    render(<SubscribersTable rows={[row(1), row(2)]} total={2} matching={2} offset={0} limit={25} />);

    const body = screen.getAllByRole("rowgroup")[1];
    expect(within(body).getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText("Member 1")).toBeTruthy();
    expect(screen.getByText("member1@example.com").getAttribute("href")).toBe(
      "mailto:member1@example.com",
    );
  });

  // THE ACCEPTANCE CRITERION: a cancelled subscriber is visible without opening
  // anything. Proven three ways, because any one of them alone could be lost in
  // a refactor and the screen would still "render".
  it("marks a cancelled subscriber distinctly, with no interaction", () => {
    render(
      <SubscribersTable rows={[row(1), cancelled(2)]} total={2} matching={2} offset={0} limit={25} />,
    );

    // 1. The row itself is flagged, not just one cell.
    const flagged = screen.getAllByTestId("subscriber-row-cancelled");
    expect(flagged).toHaveLength(1);
    expect(flagged[0].className).toContain("is-cancelled");

    // 2. A red status pill, and red is reserved for cancelled.
    const pill = within(flagged[0]).getByText("Cancelled");
    expect(pill.className).toContain("pill");
    expect(pill.className).toContain("red");

    // 3. The cancellation date is in the row, on screen, unclicked.
    const cell = flagged[0].querySelector(".subs-cancelled-on");
    expect(cell).toBeTruthy();
    expect(cell!.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-09-02T00:00:00.000Z",
    );

    // The healthy row is NOT flagged.
    expect(screen.getAllByTestId("subscriber-row")).toHaveLength(1);
  });

  it("reserves the red pill for cancelled — lapsed and trial read differently", () => {
    expect(statusPill("canceled").className).toContain("red");
    expect(statusPill("active").className).toContain("green");
    expect(statusPill("trial").className).toContain("amber");
    expect(statusPill("lapsed").className).not.toContain("red");
    // Copy: this view says "Cancelled", not a raw db value.
    expect(statusPill("canceled").label).toBe("Cancelled");
  });

  it("shows tenure in months, singular for one", () => {
    render(
      <SubscribersTable
        rows={[row(1, { tenureMonths: 1 }), row(2, { tenureMonths: 14 })]}
        total={2}
        matching={2}
        offset={0}
        limit={25}
      />,
    );
    expect(screen.getByText("mo")).toBeTruthy();
    expect(screen.getByText("mos")).toBeTruthy();
    expect(screen.getByText("14")).toBeTruthy();
  });

  it("shows the headline count, which is the UNFILTERED total", () => {
    render(
      <SubscribersTable
        rows={[cancelled(1)]}
        total={128}
        matching={1}
        status="canceled"
        offset={0}
        limit={25}
      />,
    );
    // "All subscribers", not "Subscribers": the count includes cancelled and
    // lapsed rows, unlike the dashboard Members tile.
    expect(screen.getByTestId("subscribers-total").textContent).toContain("128");
    expect(screen.getByTestId("subscribers-total").textContent).toContain("All subscribers");
    expect(screen.getByText(/Showing 1 of 1 subscriber/)).toBeTruthy();
  });

  it("renders the empty state for an empty base, and a different one when filtered", () => {
    const { unmount } = render(
      <SubscribersTable rows={[]} total={0} matching={0} offset={0} limit={25} />,
    );
    expect(screen.getByText(/No subscribers yet/)).toBeTruthy();
    unmount();

    render(
      <SubscribersTable
        rows={[]}
        total={40}
        matching={0}
        status="canceled"
        offset={0}
        limit={25}
      />,
    );
    expect(screen.getByText(/No subscribers match these filters/)).toBeTruthy();
  });

  it("keeps the pager reachable on a page past the end", () => {
    render(<SubscribersTable rows={[]} total={40} matching={40} offset={100} limit={25} />);
    expect(screen.getByText(/the list ends earlier/)).toBeTruthy();
    expect(screen.getByText("‹ Prev").getAttribute("href")).toBe("/subscribers?offset=75");
  });

  it("marks the active status and tenure chips", () => {
    render(
      <SubscribersTable
        rows={[cancelled(1)]}
        total={9}
        matching={1}
        status="canceled"
        band="6-11"
        offset={0}
        limit={25}
      />,
    );
    expect(screen.getByTestId("status-filter-canceled").className).toContain("active");
    expect(screen.getByTestId("status-filter-active").className).not.toContain("active");
    expect(screen.getByTestId("tenure-filter-6-11").className).toContain("active");
    expect(screen.getByTestId("tenure-filter-any").className).not.toContain("active");
  });

  describe("hrefs", () => {
    it("carries filters across a page step, and drops a zero offset", () => {
      expect(buildSubscribersHref({ status: "canceled", band: "12", offset: 25 })).toBe(
        "/subscribers?status=canceled&band=12&offset=25",
      );
      expect(buildSubscribersHref({})).toBe("/subscribers");
      expect(buildSubscribersHref({ status: "all" })).toBe("/subscribers");
    });

    // The export covers the whole FILTERED set — every page. It must carry the
    // filters and must NOT carry the page window.
    it("exports the filtered set, translating the band to month bounds, with no paging", () => {
      expect(buildExportHref({ status: "canceled", band: "6-11", q: "mel" })).toBe(
        "/api/admin/subscribers/export?status=canceled&minMonths=6&maxMonths=11&q=mel",
      );
      // An open-ended band sends only the lower bound.
      expect(buildExportHref({ band: "12" })).toBe(
        "/api/admin/subscribers/export?minMonths=12",
      );
      expect(buildExportHref({})).toBe("/api/admin/subscribers/export");
    });

    it("points the export at the same cohort the table is showing", () => {
      render(
        <SubscribersTable
          rows={[cancelled(1)]}
          total={9}
          matching={1}
          status="canceled"
          band="3-5"
          offset={25}
          limit={25}
        />,
      );
      const href = screen.getByTestId("subscribers-export").getAttribute("href")!;
      expect(href).toContain("status=canceled");
      expect(href).toContain("minMonths=3");
      expect(href).toContain("maxMonths=5");
      // Never the page window.
      expect(href).not.toContain("offset");
    });
  });

  it("ignores an unknown band id rather than inventing a filter", () => {
    expect(bandById("nonsense")).toBeUndefined();
    expect(bandById(undefined)).toBeUndefined();
    expect(bandById("6-11")?.minMonths).toBe(6);
    // Every band the chips render is resolvable by its own id.
    for (const b of TENURE_BANDS.filter((b) => b.id)) {
      expect(bandById(b.id)).toBe(b);
    }
  });
});
