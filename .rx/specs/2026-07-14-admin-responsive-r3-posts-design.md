# Admin responsive — R3 posts library (ENG-245)
Epic: ENG-242 · Base: `feature/admin-responsive-v1` · Blocked by ENG-243 · Full spec in Linear; shared rules in the epic design md.

## Surface (owns)
`app/(dash)/posts/**`, `e2e/posts.spec.ts`. Do-NOT-touch `SearchField.tsx` (shared), `globals.css`.

## Decisions
- <720px: table rows → stacked cards (thumb, title+excerpt, horse/trainer, type+status pills, when, status action); card tap = row navigation to `/compose?id=…`; actions stopPropagation. Same `PostView` data, no duplicate fetch.
- Chips wrap; search inputs full-width. Long text clamps. Cards keep tabIndex/Enter a11y.
- Guardrail: per-status affordances unchanged (Discard drafts-only, unpublish = soft-hide). Design ref: `screens/04-posts.html`.

## Tests
jsdom: card mode renders per-post card; action click ≠ navigate. e2e: mobile no-h-scroll, cards visible, screenshots. Full suite green.
