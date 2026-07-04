# stablepass-admin — Guardrails (non-negotiable)

Admin dashboard (`admin.stablepass.co`) + admin BFF. Every route is behind `requireAdmin()`.

## 1. Every admin route requires is_admin
No admin endpoint may skip `requireAdmin()` (401 no session, **403** non-admin). Admin = an `app_user` row with `is_admin=true`.
- **Test:** each `app/api/admin/*` route returns 403 for a non-admin session.

## 2. Content admin-gated; soft-hide, never hard-delete published
Posts move draft→scheduled→published→unpublished. `unpublish` is a reversible soft hide. **Only a draft may be hard-deleted** (`DELETE /api/admin/posts/:id` rejects non-drafts with 409).
- **Test:** DELETE on a published post → 409; unpublish keeps the row.

## 3. trainer_contact is internal, admin-only
Managed here; never exposed to member surfaces.

## 4. No owner PII, ever
Admin never creates/edits/stores a horse **owner**. There is no owner field.

## 5. Media split
Post video → Mux; images/voice → Supabase Storage; admin photo uploads go **direct to Storage**. No public post-media bucket.

## 6. No betting / bookmaker anything
No odds/bets/wagering/bookmaker UI or fields.

## 7. Positive-only reactions, no comments
Analytics may aggregate reactions; there is no comment concept to surface.

## 8. Secrets from env
No secrets committed. Mux/Supabase keys from env.

## Design
Admin screens build against `.rx/mockups.md`. No confirmed reference → `needs-spec`.
