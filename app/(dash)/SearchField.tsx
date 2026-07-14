"use client";

// Debounced search-as-you-type for the URL-driven list screens (horses /
// trainers / posts). Typing updates `?q=` via router.replace after a short
// pause, so the server list refilters without pressing Enter. It stays a GET
// form, so Enter still submits instantly and deep-links keep working.
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./icons";

const DEBOUNCE_MS = 300;

export default function SearchField({
  action,
  className,
  placeholder,
  ariaLabel,
  defaultValue = "",
  hidden = {},
}: {
  /** List page path, e.g. "/horses". */
  action: string;
  /** The form's CSS class ("search", "search wide", "search-mini", …). */
  className: string;
  placeholder: string;
  ariaLabel: string;
  defaultValue?: string;
  /** Other query params to preserve while searching (status, filter, …). */
  hidden?: Record<string, string>;
}) {
  const router = useRouter();
  const [value, setValue] = useState(defaultValue);
  const [, startTransition] = useTransition();
  const mounted = useRef(false);

  const hiddenKey = JSON.stringify(hidden);
  useEffect(() => {
    // Only navigate in response to typing — never on mount.
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const t = setTimeout(() => {
      const params = new URLSearchParams(JSON.parse(hiddenKey) as Record<string, string>);
      const q = value.trim();
      if (q) params.set("q", q);
      const qs = params.toString();
      startTransition(() => router.replace(qs ? `${action}?${qs}` : action));
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [value, action, hiddenKey, router]);

  return (
    <form className={className} action={action} method="get">
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <Icon name="search" />
      <input
        name="q"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(e) => setValue(e.target.value)}
      />
    </form>
  );
}
