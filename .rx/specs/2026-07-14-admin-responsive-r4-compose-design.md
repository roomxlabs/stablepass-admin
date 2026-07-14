# Admin responsive — R4 compose (ENG-246)
Epic: ENG-242 · Base: `feature/admin-responsive-v1` · Blocked by ENG-243 · Full spec in Linear; shared rules in the epic design md.

## Surface (owns)
`app/(dash)/compose/**`, `e2e/compose.spec.ts`. Do-NOT-touch `lib/**`, `app/api/**`, `globals.css`.

## Decisions
- <720px: single column; mini-preview rail stacks BELOW the form; PreviewModal frames stack vertically (Mobile first, scrollable).
- Sticky bottom action bar (primary + Cancel) with `env(safe-area-inset-bottom)`; content bottom-padded; validation errors visible above it.
- Upload zone / horse search / video player / inputs fit 320px; upload-progress, error, edit read-only media states covered.
- Behaviour byte-identical (direct uploads, publish/schedule, edit PATCH). Design ref: `screens/03-compose.html`.

## Tests
Existing jsdom tests stay green. e2e: mobile no-h-scroll (create + edit), sticky bar visible, modal shows both frames, screenshot. Full suite green.
