import Link from "next/link";
import { ariaSortFor, nextSortDir, type SortDir } from "./list-href";
import "./sortable-th.css";

// A sortable column header for the admin list tables (posts / trainers).
//
// It is a plain `<th>` wrapping a `<Link>`, NOT a click-handler on the th:
//   * the anchor is keyboard-operable for free (Tab reaches it, Enter follows
//     it) with no key handling of our own and no tabIndex/role juggling;
//   * sort therefore lives in the URL, so it survives a refresh, a share and a
//     back button exactly like the filter chips already do;
//   * it works with JS off, and middle-click/⌘-click open a sorted view in a
//     new tab.
//
// `aria-sort` is set on the `<th>` (where the a11y tree expects it) and is
// "none" on every column except the active one — a table that reports two
// sorted columns is worse than one that reports none.

export type SortableThProps = {
  /** The `?sort=` value this header owns. */
  column: string;
  /** Visible header label. */
  label: string;
  /** The list's active `?sort=` ("" when unsorted / default order). */
  sort: string;
  /** The list's active `?dir=`. */
  dir: SortDir;
  /**
   * Direction a FIRST click on this column produces — "desc" for dates and
   * counts (newest / biggest first), "asc" for names and statuses.
   */
  defaultDir?: SortDir;
  /** Builds the href for (column, direction). The screen owns its other params. */
  hrefFor: (column: string, dir: SortDir) => string;
  className?: string;
  style?: React.CSSProperties;
};

export default function SortableTh({
  column,
  label,
  sort,
  dir,
  defaultDir = "desc",
  hrefFor,
  className,
  style,
}: SortableThProps) {
  const active = sort === column;
  const target = nextSortDir(column, sort, dir, defaultDir);
  const ariaSort = ariaSortFor(column, sort, dir);

  const cls = ["th-sort", active ? "is-active" : ""].filter(Boolean).join(" ");

  return (
    <th aria-sort={ariaSort} className={className} style={style} data-testid={`th-${column}`}>
      <Link
        href={hrefFor(column, target)}
        className={cls}
        // Announced instead of a bare label so a screen-reader user hears what
        // activating the link will DO, not just which column it names.
        title={`Sort by ${label} (${target === "asc" ? "ascending" : "descending"})`}
      >
        <span>{label}</span>
        <span className="th-sort-ind" aria-hidden="true">
          {active ? (dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </Link>
    </th>
  );
}
