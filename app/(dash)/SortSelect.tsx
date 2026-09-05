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
import { useTransition } from "react";

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

  return (
    <form className="sort-select" action={action} method="get">
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <label className="sort-select-label" htmlFor="list-sort">
        {label}
      </label>
      <select
        id="list-sort"
        name="sort"
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => {
          const params = new URLSearchParams(hidden);
          if (e.target.value) params.set("sort", e.target.value);
          const qs = params.toString();
          startTransition(() => router.replace(qs ? `${action}?${qs}` : action));
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
