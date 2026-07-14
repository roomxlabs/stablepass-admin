# Admin responsive — R6 trainers (ENG-248)
Epic: ENG-242 · Base: `feature/admin-responsive-v1` · Blocked by ENG-243 · Full spec in Linear; shared rules in the epic design md.

## Surface (owns)
`app/(dash)/trainers/**`, `e2e/trainers.spec.ts`.

## Decisions
- List 1-col <720px; chips wrap; search full-width; add/edit forms 1-col + sticky save bar.
- Contacts table → stacked cards (name, role, email/phone break-word, edit/delete ≥44px).
- Guardrail §3: trainer_contact stays inside this gated screen only. Design refs: `screens/06-trainers.html`, `08-add-trainer.html`.

## Tests
e2e: mobile no-h-scroll on `/trainers` + `/trainers/new`, contacts as cards, screenshots (populated + empty). Full suite green.
