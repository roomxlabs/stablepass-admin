# CLAUDE.md — stablepass-admin

Operator **admin dashboard + BFF** (`admin.stablepass.co`, Next.js App Router, TS). Same BFF pattern as `stablepass-web`, but **every route is behind `requireAdmin()`** and endpoints live under `app/api/admin/*`. Read `docs/specs/`; `.rx/guardrails.md` is the non-negotiable subset.

## Architecture
- **Admin = `app_user.is_admin=true` + an AAL2 (TOTP) session** (no separate identity). `lib/auth/admin.ts#requireAdmin()` gates every route (401 no session, 403 non-admin, 403 `mfa_required` for an AAL1 admin); `requireAdminPage()` redirects instead. Sign-in is **two steps**: `/signin` (password) → `/signin/mfa` (code), or `/signin/mfa-setup` when nothing is enrolled. After ENG-368 Postgres's own `is_admin()` requires aal2 too, so an AAL1 admin reads **0 rows with no error** — always gate before reading.
- Tokens in httpOnly cookies (`@supabase/ssr`); `lib/supabase/server.ts` is the only server client. Admin's RLS `*_all_admin` policies grant the elevated read/write.
- Envelope + status via `lib/api/envelope.ts`.
- Media: video → Mux, images/voice → Supabase Storage (direct).

## Endpoints (`app/api/admin/*`)
- **posts**: list `?status=&horseId=&q=`, create draft, edit, **discard draft** (DELETE, draft-only), publish / schedule / unpublish / republish.
- **races**: create event, attach runner, record runner result; horse-first `horses/:id/races` (find-or-create).
- **horses**: create, edit, stats. **trainers**: create, edit, contacts, `contacts/:id`.
- **dashboard**: `race-day` (content queue), `analytics`, `subscribers`.

## Dev
```bash
nvm use 22 && npm install
npm run dev -- -p 3002    # admin on its own port
npm run typecheck && npm run lint && npm run build && npm test
```

## Conventions
- **Never commit or offer to commit.** Stop at `git add` + `git status`.
- Node 22. Every route needs a test (403-for-non-admin + happy path). Design source in `.rx/mockups.md`.
