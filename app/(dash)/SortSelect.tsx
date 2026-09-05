"use client";

// Sort control for a CARD-GRID list, where there is no header row to click
// (Horses). A `<select>` inside a GET form pointed at the list, carrying the
// screen's other params as hidden inputs — the same shape as SearchField, so
// sort stays URL-driven and shareable here exactly as it is on the tables.
//
// `onChange` navigates so a mouse user needs one interaction rather than
// two-plus-Apply. It is NOT the only way through: the form still submits on
// Enter, and the "Sort" button below is rendered for anyone without JS. That
// button is hidden from sighted users only via `.sort-select-go` — a
// keyboard user tabbing to it still gets a real, focusable control.
import { useRouter } from "next/navigation";
import { useId, useTransition } from "react";

export type SortOption = { value: string; label: string };

export default function SortSelect({
  action,
  options,
  value,
  hidden = {},
  ariaLabel = "Sort",
  label = "Sort",
}: {
  /** List page path, e.g. "/horses". */
  action: string;
  options: SortOption[];
  value: string;
  /** Other query params to preserve while sorting (filter, q, trainerId, …). */
  hidden?: Record<string, string>;
  ariaLabel?: string;
  label?: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  // `useId` rather than a hardcoded "list-sort": two selects on one page would
  // otherwise share an id, and the second label would point at the first field.
  const id = useId();

  return (
    <form className="sort-select" action={action} method="get">
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <label className="sort-select-label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        name="sort"
        // No `aria-label` here: it would OVERRIDE the visible <label> above and
        // leave the two disagreeing. The visible "Sort" plus the option text is
        // the accessible name, and `title` carries the longer description.
        title={ariaLabel}
        value={value}
        onChange={(e) => {
          const params = new URLSearchParams(hidden);
          if (e.target.value) params.set("sort", e.target.value);
          const qs = params.toString();
          // `push`, not `replace`: changing the sort is a navigation the
          // operator should be able to undo with the Back button, exactly like
          // clicking a sortable column header (a <Link>) already can be.
          startTransition(() => router.push(qs ? `${action}?${qs}` : action));
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <button type="submit" className="sort-select-go">
        Sort
      </button>
    </form>
  );
}
