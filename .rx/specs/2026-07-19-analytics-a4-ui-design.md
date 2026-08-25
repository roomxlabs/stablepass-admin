# Analytics v1 — A4 · admin · analytics page + per-post page (ENG-276)

Epic: ENG-272 · Base branch: `feature/analytics-v1` · Blocked by: ENG-275 (endpoints)

## Design (CONFIRMED references — build live from these)
- `06-stage1-design/mockups/web/admin/screens/09-analytics.html` (main)
- `06-stage1-design/mockups/web/admin/screens/10-post-analytics.html` (per-post)
- Tokens: `06-stage1-design/mockups/web/style.css`; port rules into a scoped module (do NOT edit globals.css)
- Charts: single-series brand-green inline SVG (bars rx4 rounded value-ends, hover `--brand-green-dark`, peak `--brand-green-darker`; line chart for opens-since-publish). NO chart library.

## Surface
`app/(dash)/analytics/page.tsx` + `analytics-screen.tsx` + sections + `analytics.module.css`; `app/(dash)/analytics/posts/[id]/page.tsx` + `post-analytics.tsx`; `app/(dash)/AdminNav.tsx` (shared-surface: nav item only); `.rx/mockups.md` (add rows 09+10); `e2e/analytics.spec.ts` + `e2e/mock-supabase.mjs` additions; component tests (jsdom per-file).

## Behaviour
- Period toggle 7d/30d/all via `?period=` search param; default 30d; server component refetch.
- Page re-asserts `requireAdminPage()` (layout gate insufficient — gotcha).
- Hour chart converts UTC → browser-local (reuse LocalTime approach from time-display-v1 if merged; else render AEST + note).
- Trials: monthly bars + list + Download CSV → `analytics/trials?format=csv`.
- Trainer table has clicks column + compliance pill ("counts only · per-account detail pending compliance").
- Top posts → `/analytics/posts/[id]`: tiles (opens, reactions, saves, reach), opens-since-publish line, reactions-by-emoji bars rendering whatever the API returns (no hardcoded emoji set).
- Empty states on every card (new platform = zeros).

## Guardrails
No member-identifying data except the trials list · mock-supabase: register specific handlers BEFORE the generic dispatcher, discriminate by query string; RPC paths `/rest/v1/rpc/*` get own handlers.

## Acceptance
Playwright screenshots (populated + empty + per-post) against `next start`; component tests (toggle, CSV link, empty states); full gate green: typecheck, lint, build, test, e2e.

## Out of scope
Dashboard tiles, mobile responsive (R-epic), per-account clicks.
