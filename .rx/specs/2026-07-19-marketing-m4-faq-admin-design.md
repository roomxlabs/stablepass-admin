# Marketing v1 — M4 · admin · FAQ management (ENG-283)

Epic: ENG-279 · Base branch: `feature/marketing-v1` (seed from `feature/analytics-v1` tip AFTER ENG-276 lands — AdminNav.tsx already carries the Analytics item then, avoiding the shared-file collision) · Blocked by: ENG-280 (faq table), ENG-276 (AdminNav).

## Surface
`app/api/admin/faqs/route.ts` (GET incl. unpublished, POST) · `app/api/admin/faqs/[id]/route.ts` (PATCH, DELETE) · `app/(dash)/faqs/page.tsx` + `faqs-screen.tsx` + module CSS · `app/(dash)/AdminNav.tsx` ("FAQs" under Library — shared-surface, minimal diff) · tests beside each.

## Behaviour
List by sort_order, drafts visually distinct · form: question, answer, published toggle · reorder via sort_order up/down (no drag lib) · DELETE allowed (faqs aren't member content; unpublish toggle is the soft path) · envelope + requireAdmin() everywhere (401/403).

## Guardrails
403 non-admin on every route (tested) · no new dependencies.

## Acceptance
Route tests (403 + create/edit/publish/reorder/delete) · screen test renders list + drafts distinct · typecheck, lint, build, test green.
