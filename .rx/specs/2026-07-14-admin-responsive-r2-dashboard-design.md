# Admin responsive — R2 dashboard (ENG-244)
Epic: ENG-242 · Base: `feature/admin-responsive-v1` · Blocked by ENG-243 · Full spec in Linear; shared rules in the epic design md.

## Surface (owns)
`app/(dash)/page.tsx`, `app/(dash)/dashboard.css`, `e2e/dashboard.spec.ts`.

## Decisions
- <720px: stat tiles 2-col (1-col if 2 don't fit at 320px); race-day queue + quiet horses stack 1-col full-width; mobile paddings.
- Same data/sections; desktop pixel-equal. Design ref: `screens/02-dashboard.html`.

## Tests
e2e: mobile viewport `scrollWidth <= innerWidth`, tiles visible, screenshots (populated + empty). Full suite green.
