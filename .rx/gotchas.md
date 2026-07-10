# stablepass-admin — Gotchas

## Every route starts with the admin gate
```ts
const g = await requireAdmin(); if ("res" in g) return g.res; const { sb } = g;
```
`sb` is the caller's RLS client; because they're admin, RLS `*_all_admin` policies apply. Never use a service-role client here.

## Same BFF primitives as stablepass-web
`lib/supabase/server.ts`, `lib/api/envelope.ts` are copied from web — keep them in sync. Envelope + status codes are the contract (403 = non-admin here).

## Race entry is two paths onto one runner
Race-first (`POST /races` → `POST /races/:id/runners`) and horse-first (`POST /horses/:id/races`, find-or-create the event) both end at a `race_horse` row. Results are per-runner (`POST /race-horses/:id/result`), which fans out `race_result` via the be push-dispatch function.

## Media uploads
Video → Mux, image/voice → Storage — the actual upload/watermark is orchestrated by the be side / Storage SDK; the admin route records the resulting ids/urls.

## Tests are the pass/fail
Each route ticket needs a test asserting the 403-for-non-admin branch + the happy-path status/envelope.

## Mockups path drifts from .rx/mockups.md
`.rx/mockups.md` says `../docs/dev-handover/mockups/web/admin/`, but the real screens live at
`../dev-handover/StablePass-mockups/mockups/web/admin/screens/` and the shared design system is
`../dev-handover/StablePass-mockups/mockups/web/style.css` (same tokens as member web). Build FE from
that file; pull real values (`--brand-green:#285D50`, `--brand-green-darker:#122E26`, `--cream:#FAF7F2`,
Inter/Cormorant) rather than eyeballing.

## The admin sign-in mockup is stale on 2FA — spec wins
`screens/01-signin.html` shows an "Authenticator code" field + "Protected by 2FA" legal line, but the
ticket, CLAUDE.md, `.rx/mockups.md` and `docs/specs/screen-api-map.md` all say **no 2FA in v1**. Build
email+password only. Don't let a reviewer flag the missing 2FA field as a miss.

## First FE ticket bootstraps the toolchain (done in ENG-173)
The scaffold ships **no test runner and no design system**. ENG-173 added: vitest (`npm test` =
`vitest run`), the shared design tokens installed into `app/globals.css` with fonts wired via
`next/font` (Inter + Cormorant → `--font-inter`/`--font-cormorant`), and a Playwright screenshot
harness under `e2e/` that stands up a **mock Supabase HTTP server** (`e2e/mock-supabase.mjs`) so the
gated flow renders without a live backend (`npm run e2e`). `e2e/**` + `playwright.config.ts` are in
`tsconfig` `exclude` so the app gate never depends on Playwright types.

## The gated dashboard is the `(dash)` index → `/`, so delete the scaffold home
`app/(dash)/page.tsx` resolves to `/`. The create-next-app `app/page.tsx` also resolves to `/` — two
pages on one route is a build error, so the scaffold `app/page.tsx` + `page.module.css` must be removed
when the `(dash)` group lands.

## Page gate vs API gate — two functions in lib/auth/admin.ts
`requireAdmin()` returns a 401/403 **Response** (for `app/api/admin/*` route handlers).
`requireAdminPage()` **redirects** (`/signin`, or `/signin?error=forbidden` for a non-admin) because a
Server Component / layout can't return a Response. Both read `app_user.is_admin` via `getUser()` (not
`getSession()`) and fail closed (`!data?.is_admin`, so a missing row is denied).

## `(dash)` layout gate does NOT gate a page's own data fetch
The `(dash)` shell gate in `layout.tsx` is airtight for a static page, but Next renders layout + page
**in parallel** and caches the layout across soft navigations — it won't re-run per page. Any
data-bearing `(dash)` page (ENG-174 dashboard, resource screens) must re-assert `requireAdminPage()` /
gate its own reads (or rely on RLS `*_all_admin`), not lean on the layout alone.
