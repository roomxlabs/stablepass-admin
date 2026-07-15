# Time display — T1 LocalTime component (ENG-251)
Epic ENG-250 · Base `feature/time-display-v1` · Full spec in Linear.
Surface: `app/(dash)/LocalTime.tsx` (new), `app/(dash)/LocalTime.test.tsx` (new). Nothing else.
"use client"; props { iso, kind: "when"|"clock"|"relative", className? }; SSR-safe empty <time> shell
filled in useEffect; label rules ported verbatim from posts/format.ts + dashboard raceTime/timeAgo,
browser-default locale. Tests: three kinds × TZ-forced variants (Australia/Perth vs Asia/Jakarta) ×
edges (null/invalid iso, 7-day boundary, midnight/noon).
