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

## Mockups live OUTSIDE the repo — real path differs from `.rx/mockups.md`
`.rx/mockups.md` writes the source as `../docs/dev-handover/mockups/web/admin/`, but the files actually
sit at `<repo>/../dev-handover/StablePass-mockups/mockups/web/admin/screens/` (and the shared design
system at `.../mockups/web/style.css`). Resolve with `find … -name '<NN>-*.html'` rather than trusting
the manifest path. Build live from the HTML + `style.css` (real token values), not from memory.

## A resource LIST screen needs no GET endpoint — Server Component reads via `supabaseServer()`
The admin list pages are Server Components under `app/(dash)/<res>/page.tsx` that query the RLS admin
client directly (gated by the layout). So a list ticket's surface may legitimately declare only the
mutation routes (e.g. ENG-179 trainers owns `POST/PATCH`, no `GET`). Keep data-fetching in a small
injectable helper (`app/(dash)/<res>/data.ts` taking `sb`) so it's unit-testable against the fake, and
use flat per-table queries + JS merge for derived columns (horse count, last-post, contact email) —
PostgREST embedding can't be verified here (no live backend), flat selects can.

## Screenshot a data-backed `(dash)` screen: extend the mock-Supabase harness
`e2e/mock-supabase.mjs` (from ENG-173) serves GoTrue + `app_user`. To screenshot a list/detail screen,
add PostgREST reads for its tables + a `POST /__control {empty}` toggle so one spec captures both the
populated and empty states (see ENG-179's trainer/horse/post/trainer_contact seed). The spec signs in
via the form, flips `/__control`, `goto`s the route, waits on a `data-testid`, and screenshots
`fullPage`. No live backend needed. Reuse this for horses (T8) and any future resource screen.

## e2e mock must honour `id=eq.` for `.maybeSingle()` single-row reads
This repo's `@supabase/postgrest-js` `.maybeSingle()` does NOT set the `pgrst.object` Accept header — it fetches as a
**list** and enforces cardinality client-side (errors → `data=null` if >1 row comes back). So a mock
(`e2e/mock-supabase.mjs`) that returns the whole fixture array for every `/rest/v1/<table>` GET makes a
`.eq("id",id).maybeSingle()` page read (e.g. the horse edit page) see N rows, null out, and hit `notFound()`. Do-this:
in the mock, branch on `url.search.includes("id=eq.")` and return the single matching fixture (object for `pgrst.object`,
singleton array otherwise). A PK-filtered `.maybeSingle()`/`.single()` is fine against a real DB (0/1 row) — this only bites the mock.

## Admin resource-screen component classes aren't in globals.css yet
ENG-173 ported only tokens + shell + buttons/inputs into `app/globals.css`. The resource-screen classes the mockups use
(`.adm-card`, `.chip`, `.pill`, `.horse-grid-adm`/`.horse-card-adm`, `.upload-zone`, `.btn-light`, `.adm-filter-bar`,
`.search-mini`) live only in the shared mockups `style.css`. Since `app/globals.css` is usually NOT in a screen ticket's
surface, ENG-178 (horses) scoped them into `app/(dash)/horses/horses.css` (imported by its pages) with values ported
verbatim from `style.css`. The next resource screen (trainers) will re-need a few — either promote the shared ones to
`globals.css` via a `shared-surface` ticket, or keep scoping per screen (duplicate CSS is harmless).

## `horse.status` (active/disabled) = visibility; `horse.training_status` = the phase
The add/edit "Visibility" select maps to `horse_status` (`active`=Visible, `disabled`=Hidden); the "Current status"
select maps to `training_status` (spelling…racing…retired). The list filter chips are training-status based: **Active =
`training_status != 'retired'`**, Racing = `'racing'`, Retired = `'retired'` (Active+Retired partition All; Racing ⊂
Active). `trainer_id` is **fixed for life of row** (schema note) — the edit route's allowlist omits it and the edit form
disables the trainer dropdown.
## Horse/trainer LISTS have no BFF endpoint — read them server-side ([PG])
`app/api/admin/horses/route.ts` + `trainers/route.ts` are **POST-create only**; there is no GET list.
Per `screen-api-map.md`, listing is Layer A `[PG] GET horse`/`trainer`. Elevated admin reads need the
session, which lives in **httpOnly cookies** — so the **browser** client (`supabaseBrowser`, anon) can't
do them. Read horse/trainer **server-side** in the page via `requireAdminPage()`'s `sb` and pass as
props (T6 Compose does this). The browser client is only good for token-authorized ops (Storage
`uploadToSignedUrl`), not RLS-gated table reads. Field mapping: horse name = `racing_name ?? display_name`;
byline default = `horse.trainer_id`; embed the trainer with `trainer:trainer_id(id,name,display_name)`.

## Post shape: it's `type` + `body`, not `media_kind` + `caption`
`post.type in ('video','photo','text','voice','news')` (compose creates video/photo only); the caption
is `post.body`; the byline is `post.source_trainer_id`. Create (`POST /api/admin/posts`) accepts
`{horseId,type,sourceTrainerId,title?}` and does **not** take the caption — set `body` afterwards via
`PATCH /api/admin/posts/:id {body, sourceTrainerId}`.

## FE screens need a CSS module — globals.css only carries the shell subset
`app/globals.css` has tokens + buttons + `admin-shell`/`admin-nav`/`admin-topbar` only. The compose /
form / member-post classes (`compose-grid`, `upload-zone`, `adm-input`, `.pill`, `.btn-light`,
`post-web`…) are **absent**. Don't edit globals.css from a screen ticket (collides with sibling screens);
port the needed rules into a scoped `*.module.css` inside the screen's own surface, referencing the
global `:root` tokens. Combine a global base class with a module modifier in JSX
(`className={`btn ${styles.btnLight}`}`).

## Component tests: repo ships no jsdom/testing-library — add per test
`vitest.config.ts` is `environment: "node"`. For a `renders`-style component test add devDeps
`@testing-library/react` + `jsdom` and put `// @vitest-environment jsdom` at the top of the `.test.tsx`.
Extract the network layer into a sibling `api.ts` and `vi.mock("./api")` so the component test never
touches fetch/Supabase/Mux. `URL.createObjectURL` is absent in jsdom — guard it in the component
(`typeof URL.createObjectURL === "function"`), don't assume it.

## Screenshots: `next start`, not `next dev`; mock server-reads, route browser-calls
Dev-mode Turbopack compile + Chromium can OOM a 16 GB box mid-run. Build once (`npm run build`) then
screenshot against `next start -p 3002` — far lighter. For a screen with server-side `[PG]` reads,
extend `e2e/mock-supabase.mjs` (the Next server hits :8787, so Playwright `page.route` can't intercept
those); for browser-side BFF/Storage calls (create-draft, signed-upload PUT), use `page.route` in the
spec so you don't touch the shared mock. Both are additive/collision-safe.
