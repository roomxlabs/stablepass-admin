# Admin responsive — R5 horses (ENG-247)
Epic: ENG-242 · Base: `feature/admin-responsive-v1` · Blocked by ENG-243 · Full spec in Linear; shared rules in the epic design md.

## Surface (owns)
`app/(dash)/horses/**`, `e2e/horses.spec.ts`.

## Decisions
- Grid 1-col <720px (2-col 720–1080 if natural); chips wrap; search full-width.
- Add/edit forms 1-col + sticky save bar; photo upload zone full-width; errors visible above the bar.
- No field changes (guardrail §4 no owner PII); trainer dropdown stays disabled in edit. Design refs: `screens/05-horses.html`, `07-add-horse.html`.

## Tests
e2e: mobile no-h-scroll on `/horses` + `/horses/new`, 1-col cards, screenshots (populated + empty). Full suite green.
