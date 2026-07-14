# Admin responsive — R7 [Gate] (ENG-249)
Epic: ENG-242 · Base: `feature/admin-responsive-v1` · Blocked by ENG-243–248 · Full spec in Linear.

## Surface (owns)
`e2e/screenshots.spec.ts`, `e2e/__screenshots__/**` (mobile set).

## Decisions
- Mobile screenshot set at 375×812 for every screen (populated + empty via `__control`); 320×700 no-horizontal-scroll sweep across all routes.
- Full gate green on the integration branch (typecheck/lint/build/test/e2e), branch rebased on `main`, then open PR → `main` with the screenshot set. Merge stays human. Regressions found here become `integration-fix` tickets, never inline patches.
