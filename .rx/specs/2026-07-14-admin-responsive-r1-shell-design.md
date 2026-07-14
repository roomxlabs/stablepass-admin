# Admin responsive — R1 shell foundation (ENG-243, shared-surface)
Epic: ENG-242 · Base: `feature/admin-responsive-v1` · Full spec in the Linear ticket; shared rules in `2026-07-14-admin-mobile-responsive-epic-design.md`.

## Surface (owns)
`app/globals.css`, `app/(dash)/layout.tsx`, `app/(dash)/AdminNav.tsx`, `AdminNav.test.tsx` (new), `e2e/shell.spec.ts` (new).
Do-NOT-touch: screen dirs, `app/api/**`, `e2e/mock-supabase.mjs`.

## Decisions
- <900px: sidebar hidden; topbar hamburger (≥44px) → slide-in drawer over backdrop; closes on link tap / backdrop / Escape; body scroll locked; resets when resized ≥900px; a11y: `aria-expanded`, focus return.
- Establishes the <720px content-stacking convention (documented in globals.css); screens implement their own stacking in scoped CSS.
- Sign-in (`.admin-signin*`) fits 320px; global buttons/inputs ≥44px tall on mobile.
- ≥900px pixel-equal to today (desktop screenshots unchanged).

## Tests
jsdom: drawer open/close/Escape/aria. e2e `shell.spec.ts`: 320×700 no horizontal scroll on `/signin` + `/`, drawer works, mobile screenshot. Full suite green.
