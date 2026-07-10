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

## Admin API routes ship as T1 scaffold stubs — flesh them out in place
Routes like `app/api/admin/posts/**` already exist in the base branch as stubs with a
`// TODO(ticket):` marker and a placeholder body (`return ok({ id, action })`). An endpoint ticket
(e.g. ENG-175/T5) edits those files in place, not greenfield — read the stub first and keep the
`requireAdmin` preamble.

## `api-contract.md` POST /posts row is stale (multipart + asset ids)
The doc lists `POST /api/admin/posts` as `multipart` in with `muxAssetId/muxPlaybackId/mediaUrl` in the
response. The guardrail-correct **direct-upload** flow (bytes never transit our server) is **JSON in →
202 with an upload target out**: video `{ uploadUrl, muxUploadId }`, photo
`{ uploadUrl, path, token, bucket }`. Mux asset/playback ids don't exist until *after* the client's
direct upload (a webhook, later). T6 Compose must send JSON then PUT the bytes to the returned target.
A `502 storage_unavailable` code (photo path) was added alongside the doc's `mux_unavailable`.

## push-dispatch is invoked with the admin session, not a service-role secret
Publish/result fan-out calls `sb.functions.invoke("push-dispatch", …)` on the caller's RLS client — the
edge function holds service role internally (T2). The admin BFF never imports a service-role key. Keep
the fan-out best-effort (wrap in try/catch) so a notify failure never rolls back the status transition.

## No Mux SDK dependency — use the REST API
`lib/mux.ts` creates a direct upload via `fetch` to `https://api.mux.com/video/v1/uploads` with a
Basic-auth header from `MUX_TOKEN_ID`/`MUX_TOKEN_SECRET`; `playback_policy: ["signed"]`. Don't add
`@mux/mux-node` — it isn't in package.json and isn't needed for upload-URL creation.

## Route unit tests: mock `@/lib/supabase/server`, not the gate
`requireAdmin()` calls `supabaseServer()`, so `vi.mock("@/lib/supabase/server")` drives both the gate
(`app_user.is_admin`) and the route's own reads/writes from one fake. `lib/testing/supabase-fake.ts` is
a reusable scriptable client (per-table `select` vs `mutate` results, `functions.invoke`,
`storage.createSignedUploadUrl`) — reuse it for the other admin route tickets.
