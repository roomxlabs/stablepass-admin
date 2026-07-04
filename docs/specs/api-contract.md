# StablePass — API Contract

Derived from the Stage 1 blueprint (API Design 03, Auth & RBAC 04). REST over HTTP, JSON.

**Two layers on one platform (Supabase):**
- **Layer A — Direct data (PostgREST + RLS).** Simple reads and a subscriber's *own* engagement writes go straight to the tables via the Supabase SDK. **RLS is the security boundary**, not application code. Rows shown as `PostgREST` below.
- **Layer B — Custom endpoints (Next.js route handlers / Edge Functions)** under `/api/…`, for orchestration that is more than one governed table write. These return the standard envelope and use the service role only where they must.

**Auth.** Every call carries a Supabase-issued **JWT** (`sub` = subscriber id, read by RLS as `auth.uid()`). Web holds tokens in httpOnly cookies via the BFF; mobile sends `Authorization: Bearer <jwt>`. Admin endpoints additionally require the `is_admin` claim. Login / logout / refresh are handled by Supabase Auth (not custom endpoints).

**Session policy — one device.** A user may be signed in on **exactly one device at a time**. On every successful sign-in the BFF/auth hook **revokes all of the user's other Supabase sessions** (service role), so a login on a new device signs the previous one out; the old device's next refresh fails (`401`) and it returns to the login screen. Other devices' `device_token`s are pruned on login so push only ever targets the active device. "Log out everywhere" is therefore just a normal log out (there is only one session).

**Content gate.** Content is returned only when `subscription.status ∈ {trial, active}` — enforced in RLS *and* re-checked in every custom endpoint that returns content (including when minting Mux signed URLs). A lapsed caller requesting content gets **402**. A hidden/unpublished row returns **404** (never 403) so its existence isn't leaked.

**Envelope.** Custom endpoints wrap payloads in `data`; lists add `meta: { nextCursor, hasMore }`. Errors are `{ error: { code, message, fields? } }`. **Pagination** is opaque cursor (`?cursor=…&limit=20`, default 20, max 50). Timestamps are ISO-8601 UTC (`Z`). Money is integer cents.

**Media storage.** Two backends by media type: **video → Mux** (ingested via `POST /api/admin/posts`, watermarked, served only through short-lived signed playback URLs — `mux_asset_id` / `mux_playback_id` on `post`); **images & voice/audio → Supabase Storage** (`media_url` on `post`; profile/horse/trainer photos → `photo_url`). Photo uploads on the admin forms go **directly to Supabase Storage** (client SDK), not through a custom endpoint; only the resulting URL is stored. No media is ever a public asset that bypasses the subscription gate.

---

## Auth & session

| Method | Path | Description | Request (params/body) | Response | Status |
|---|---|---|---|---|---|
| POST | `/api/auth/signup` | Create auth user + subscriber + **trial** subscription atomically. No card, no Stripe. Trial-start form collects **name, email, phone, and a password** (the FE mockup adds the password field). | `{ name, email, phone, password }` | `{ data: { subscriber, subscription:{ status:"trial", trialEndsAt } } }` | 201 · 400 `validation_failed` · 409 `email_taken` · 429 |
| POST | `/api/auth/bootstrap` | Idempotently ensure subscriber + trial subscription exist after a first **social** (Apple/Google/Facebook) login. Also backed by a DB trigger on `auth.users` insert. | *(JWT only)* | `{ data: { subscriber, subscription } }` | 200 · 201 · 401 |
| GET | `/api/me` | Current subscriber profile + subscription summary + notification prefs. | *(JWT)* | `{ data: { subscriber, subscription:{ status, trialEndsAt, currentPeriodEnd }, prefs } }` | 200 · 401 |
| PATCH | `/api/me` | Edit own profile (Account → *Profile · Edit*) and notification-type toggles. Email/password change go through **Supabase Auth**, not here. | `{ name?, phone?, prefs?:{ newPost?, raceDay?, raceResult?, milestone? } }` | `{ data: { subscriber, prefs } }` | 200 · 400 · 401 |
| — | *Login / logout / token refresh* | Handled by **Supabase Auth** via the client SDK (email/pw + Apple/Google/Facebook). | — | — | — |

## Subscription & billing *(web only)*

**Embedded checkout — no Stripe-hosted redirect.** The card form lives **in-app** (Stripe **Elements** / Payment Element, incl. Apple Pay & Google Pay). Card data goes **directly from the browser to Stripe via Stripe.js** — it never touches our backend (PCI-safe). Our endpoint only creates the Stripe objects and returns a **client secret**; the client confirms the payment inline. Conversion is finalised by the webhook.

| Method | Path | Description | Request | Response | Status |
|---|---|---|---|---|---|
| POST | `/api/subscription/checkout` | Create/reuse Stripe **Customer** + a **Subscription** (status `incomplete`) with its first **PaymentIntent** for the single flat monthly plan (~A$19). Returns the PaymentIntent **client secret** for the embedded Payment Element to confirm inline. **No redirect.** | *(JWT)* | `{ data: { clientSecret, publishableKey, subscriptionId } }` | 200 · 401 · 409 `already_active` · 502 `stripe_unavailable` |
| POST | `/api/subscription/cancel` | Cancel at period end (replaces the hosted billing portal — no Stripe-hosted page). Access retained until `current_period_end`. | *(JWT)* | `{ data: { status:"canceled", currentPeriodEnd } }` | 200 · 401 · 409 (not active) |
| POST | `/api/subscription/payment-method` | *(optional)* Create a **SetupIntent** so the member can update their card inline via the same embedded Elements form. | *(JWT)* | `{ data: { clientSecret } }` | 200 · 401 |
| POST | `/api/webhooks/stripe` | Stripe webhook receiver. `payment_intent.succeeded`/`invoice.paid` → `status=active` + store Stripe ids + `current_period_end`; cancel/fail → `canceled`/`lapsed`. **Service role; Stripe-signature verified, idempotent on event id.** | Stripe event | `204` | 204 · 400 (bad signature) |
| — | *trial-sweep* | **Scheduled job** (not HTTP): flips `trial → lapsed` at `trial_ends_at` for un-converted trials. | — | — | — |

## Feed *(ranked: like-weight + recency + unseen-first; gated)*

| Method | Path | Description | Request | Response | Status |
|---|---|---|---|---|---|
| GET | `/api/feed?cursor=&limit=` | Global ranked feed; **records impressions** for returned items so they sink next load. | `cursor?`, `limit≤50` | `{ data:[ post… ], meta:{ nextCursor, hasMore } }` | 200 · 401 · 402 `subscription_required` · 400 `invalid_cursor` |
| GET | `/api/feed/following?cursor=` | Ranked feed restricted to followed trainers/horses. | `cursor?`, `limit?` | `{ data:[ post… ], meta }` | 200 · 401 · 402 |
| GET | `/api/trainers/:id/feed?cursor=` | One trainer's posts, chronological *(may be a direct PostgREST read)*. | `cursor?` | `{ data:[ post… ], meta }` | 200 · 401 · 402 · 404 |
| GET | `/api/horses/:id/feed?cursor=` | One horse's posts, chronological *(may be direct PostgREST)*. | `cursor?` | `{ data:[ post… ], meta }` | 200 · 401 · 402 · 404 |
| POST | `/api/feed/seen` | Batch-record impressions when items scroll into view. | `{ postIds: uuid[] }` | `204` | 204 · 401 · 429 |
| GET | `/api/posts/:id/playback` | Mint a **short-lived Mux signed playback URL** for a video post; subscription re-checked at mint time. | *(JWT)* | `{ data: { playbackUrl, expiresAt } }` | 200 · 401 · 402 · 404 |

> **Feed tabs vs Race Day.** The top tab bar is **Explore · Trainers · Horses · Following** — Explore/Following are the ranked feed (above); Trainers/Horses are browse lists (Profiles section). **Race Day is not a tab** — it's an inline "today's racing" band woven into the Explore/Following feed, a direct PostgREST read over today's `race` events joined to `race_horse` (upcoming: venue, class, distance, `scheduled_at`, barrier, jockey; finished: `result`) plus published race-result posts, under the gate. The horse profile's "Next race" card reads the same `race_horse` → `race`. No separate endpoint.

## Profiles

| Method | Path | Description | Request | Response | Status |
|---|---|---|---|---|---|
| GET | `/api/trainers/:id` | Trainer profile + their horses. | — | `{ data: { trainer, horses:[…] } }` | 200 · 401 · 402 · 404 |
| GET | `/api/horses/:id` | Horse profile: derived `displayName` (sire × dam until named), recent posts, stats, training status, race record. | — | `{ data: { horse, posts:[…], races:[…] } }` | 200 · 401 · 402 · 404 |
| GET | *trainer / horse lists* | Browse-all lists for onboarding & Trainers/Horses tabs. | `cursor?` | PostgREST array (gated) | 200 · 401 · 402 |

## Engagement *(a subscriber's own rows — direct PostgREST under RLS `user_id = auth.uid()`; named here for the contract)*

| Method | Path / Op | Description | Request | Response | Status |
|---|---|---|---|---|---|
| POST/DELETE | `follow` / `unfollow` (PostgREST `follow`) | Insert/delete a follow row. **Exactly one** of trainer/horse. | `{ trainerId? , horseId? }` | 201 / 204 | 201 · 204 · 401 · 422 (neither/both) · 409 (duplicate) |
| POST/DELETE | `notify on` / `notify off` (PostgREST `notify_optin`) | Push opt-in for a **horse or a trainer** (trainer = all their horses); **exactly one** of the two; independent of follow. | `{ horseId? , trainerId? }` | 201 / 204 | 201 · 204 · 401 · 422 (neither/both) |
| POST/DELETE | `bookmark` / `unbookmark` (PostgREST `bookmark`) | Save/unsave a post. | `{ postId }` | 201 / 204 | 201 · 204 · 401 |
| POST/DELETE | `react` / `unreact` (PostgREST `reaction`) | Upsert/delete a reaction from the curated positive-only set (👍❤️👏🙏🔥💪🐎); **moves `post.like_count`**. No comments. | `{ postId, emoji }` | 201 / 204 | 201 · 204 · 401 · 400 (bad emoji) |
| GET | `bookmarks` (PostgREST `bookmark`) | Saved posts, newest-first. | `cursor?` | array | 200 · 401 |
| GET | `notifications` (PostgREST `notification`) | Own notification inbox; drives in-app red-dot. | `cursor?` | array | 200 · 401 |
| PATCH | `notification.read` (PostgREST) | Mark own notification(s) read. | `{ read:true }` | 204 | 204 · 401 |
| POST/DELETE | `device_token` (PostgREST) | Register / prune an Expo push token for a device. | `{ expoToken, platform }` | 201 / 204 | 201 · 204 · 401 |

## Admin — content *(gated: `is_admin`; `admin.stablepass.co`)*

| Method | Path | Description | Request | Response | Status |
|---|---|---|---|---|---|
| POST | `/api/admin/posts` | Upload finished file → **video to Mux, image/voice to Supabase Storage** → watermark → create `post(status=draft)` on a horse. | multipart + `{ horseId, type, title?, sourceTrainerId, expiresAt? }` | `202` `{ data:{ id, status:"draft", muxAssetId?, muxPlaybackId?, mediaUrl?, watermarked:false … } }` | 202 · 401 · 403 · 400 · 404 `horse_not_found` · 502 `mux_unavailable` |
| GET | `/api/admin/posts?status=&horseId=&q=` | Review queue / post library. Filter by status, horse; **`q=` free-text search** (title/body/horse/trainer). | query | `{ data:[ post… ], meta }` | 200 · 401 · 403 |
| GET | `/api/admin/posts/:id/preview` | Render the post exactly as it appears on mobile **and** web before publishing. | — | `{ data: { mobile, web } }` | 200 · 401 · 403 · 404 |
| PATCH | `/api/admin/posts/:id` | Edit post fields. | `{ title?, body?, type?, expiresAt?, sourceTrainerId? }` | `{ data: post }` | 200 · 401 · 403 · 404 |
| DELETE | `/api/admin/posts/:id` | **Discard** a post — a **hard delete allowed only while `status='draft'`** (never published, so nothing to preserve). Published content is soft-hidden via unpublish, never deleted. | — | `204` | 204 · 401 · 403 · 404 · 409 (not a draft) |
| POST | `/api/admin/posts/:id/publish` | `status=published`, stamp `published_at`, **fan out `new_post` push** to the horse's notify opt-ins. | — | `{ data:{ id, status:"published", notificationsSent } }` | 200 · 401 · 403 · 404 · 409 `invalid_status` |
| POST | `/api/admin/posts/:id/schedule` | `status=scheduled` + `scheduled_for`; auto-publishes at that time (fan-out then). | `{ scheduledFor }` | `{ data:{ id, status:"scheduled", scheduledFor } }` | 200 · 400 `scheduled_for_in_past` · 401 · 403 · 404 · 409 |
| POST | `/api/admin/posts/:id/unpublish` | `status=unpublished` — reversible **soft hide**, never a delete. | — | `{ data:{ id, status:"unpublished" } }` | 200 · 401 · 403 · 404 · 409 |
| POST | `/api/admin/posts/:id/republish` | Return an unpublished post to `published`. | — | `{ data:{ id, status:"published" } }` | 200 · 401 · 403 · 404 · 409 |

## Admin — horses, trainers & races

| Method | Path | Description | Request | Response | Status |
|---|---|---|---|---|---|
| POST | `/api/admin/races` | **Race-first:** create an upcoming race **event** (`source='manual'`, `status='upcoming'`). | `{ venue, raceDate, raceNumber, raceClass?, distanceM?, scheduledAt? }` | `201` `{ data:{ id, status:"upcoming" } }` | 201 · 400 · 401 · 403 · 409 (dup event) |
| POST | `/api/admin/races/:id/runners` | Attach a platform horse to a race as a **runner** (`race_horse`). Schedules its `race_day` 2h-before reminder off the event's `scheduledAt`. | `{ horseId, barrier?, jockey? }` | `201` `{ data: raceHorse }` | 201 · 400 · 401 · 403 · 404 · 409 (already a runner) |
| POST | `/api/admin/horses/:id/races` | **Horse-first:** **find-or-create** the race event (dedup on `venue+raceDate+raceNumber`) **and** add this horse as a runner — one call from the horse page. | `{ venue, raceDate, raceNumber, raceClass?, distanceM?, scheduledAt?, barrier?, jockey? }` | `201` `{ data:{ race, raceHorse } }` | 201 · 400 · 401 · 403 · 404 `horse_not_found` |
| POST | `/api/admin/race-horses/:id/result` | Record **this runner's** result → fan out **`race_result`** push to that horse's notify opt-ins; flips the event to `finished` when its runners are done. | `{ result, finishPosition? }` | `{ data:{ id, result, notificationsSent } }` | 200 · 400 · 401 · 403 · 404 · 409 |
| PATCH | `/api/admin/races/:id` | Edit the race **event** (venue, date, number, class, distance, scheduledAt). | `{ venue?, raceDate?, raceNumber?, raceClass?, distanceM?, scheduledAt? }` | `{ data: race }` | 200 · 401 · 403 · 404 |
| PATCH | `/api/admin/race-horses/:id` | Edit a **runner** (barrier, jockey, result). | `{ barrier?, jockey?, result?, finishPosition? }` | `{ data: raceHorse }` | 200 · 401 · 403 · 404 |
| DELETE | `/api/admin/races/:id` · `/api/admin/race-horses/:id` | Remove a race event (cascades its runners) or a single runner. | — | `204` | 204 · 401 · 403 · 404 |
| PATCH | `/api/admin/horses/:id/stats` | Update manual stats. | `{ starts, wins, places, prizeMoneyCents }` | `{ data: horse }` | 200 · 401 · 403 · 404 |
| PATCH | `/api/admin/horses/:id` | Update horse attributes. | `{ trainingStatus?, status?, stableName?, sex?, colour?, foalingYear?, racingName?, … }` | `{ data: horse }` | 200 · 401 · 403 · 404 |
| POST | `/api/admin/horses` | Create a new horse (sire/dam, sex, colour, foaling year, optional stable name). | `{ trainerId, sire, dam, sex?, colour?, foalingYear?, stableName? }` | `201` `{ data: horse }` | 201 · 400 · 401 · 403 |
| POST | `/api/admin/trainers` | Create a new trainer (bio, photo, stable, location, first contacts). | `{ name, displayName?, slug, stableName?, location?, bio?, photoUrl?, status? }` | `201` `{ data: trainer }` | 201 · 400 · 401 · 403 · 409 (slug taken) |
| PATCH | `/api/admin/trainers/:id` | Update trainer profile / roster status (`active`/`onboarding`). | `{ name?, stableName?, location?, bio?, photoUrl?, status? }` | `{ data: trainer }` | 200 · 401 · 403 · 404 |
| POST | `/api/admin/trainers/:id/contacts` | Create a trainer_contact (internal, admin-only). | `{ role, name, email?, phone? }` | `201` `{ data: contact }` | 201 · 400 · 401 · 403 · 404 |
| PATCH | `/api/admin/contacts/:id` | Edit a trainer contact. | `{ role?, name?, email?, phone? }` | `{ data: contact }` | 200 · 401 · 403 · 404 |
| DELETE | `/api/admin/contacts/:id` | Remove a trainer contact. | — | `204` | 204 · 401 · 403 · 404 |

## Admin — dashboard & analytics

| Method | Path | Description | Request | Response | Status |
|---|---|---|---|---|---|
| GET | `/api/admin/race-day` | **Dashboard content queue.** Upcoming `race`s in the window joined to `race_horse` → `horse` → `trainer`, each runner annotated with its horse's **last-post recency** and a **`hasPost`** flag (has the horse been posted about recently) — the "worth a pre-race post" prompt. Orchestration read (multi-table join + recency), so a custom endpoint, not raw PostgREST. | `window?` (default `24h`), `hasPost?` (filter) | `{ data:[ { raceHorseId, scheduledAt, venue, raceNumber, raceClass, horse:{ id, name }, trainer:{ name }, lastPostAt, hasPost } ], meta }` | 200 · 401 · 403 |
| GET | `/api/admin/analytics` | Aggregate engagement: posts/reactions/saves this week, likes per trainer/horse, engagement over time, **quiet horses (no post in > 7 days)**, subscriber counts by status. | `range?` | `{ data: { … } }` | 200 · 401 · 403 |
| GET | `/api/admin/subscribers?status=` | Subscriber list with subscription status (subscriber management). | `status?`, `cursor?` | `{ data:[…], meta }` | 200 · 401 · 403 |

## System / internal *(not public HTTP endpoints)*

| Op | Trigger | Description |
|---|---|---|
| **scheduled-post publisher** | cron | Flips `scheduled → published` at `scheduled_for`, stamps `published_at`, fires `new_post` fan-out (as if publish was called). |
| **trial-sweep** | cron / nightly | Flips `trial → lapsed` at `trial_ends_at` for un-converted trials. Service role. |
| **race-day sweep** | cron | Finds `upcoming` races with `scheduled_at` ~2h out, joins `race_horse` → `notify_optin` (on the horse **or** its trainer), and fires the **`race_day`** reminder to those opt-ins (gated by each user's `pref_race_day`). |
| **push dispatch** | on publish / result / race-day / milestone | Sends Expo Push to `device_token`s + writes `notification` rows (`pushed=true`). Recipients = `notify_optin` on the **horse or its trainer**, **and** whose `app_user` type pref for that event is on. Types: **`new_post`**, **`race_day`** (2h before), **`race_result`**, **`milestone`**. General feed activity is **in-app red-dot only** (no push). |
| **poll-racing-api** | *FUTURE*, cron | Licensed feed (The Racing API + AU add-on) → find-or-creates the `race` event (`source='api'`) and a `race_horse` runner matched by `horse.racing_api_id` → `race_result` fan-out. Contingent on licensed access. **No scraping.** |

**Rate limits (indicative):** general reads 120/min per subscriber · signup 5/hour per IP · checkout 10/hour · `/api/feed/seen` 60/min · admin 300/min · admin uploads 30/hour · Stripe webhook not user-limited (signature-verified, idempotent). Over limit → **429** + `Retry-After`.

**No betting / bookmaker endpoints exist in v1.**
