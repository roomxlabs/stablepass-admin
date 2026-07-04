# StablePass — Implementation Checklist (new / changed APIs)

Everything **added or changed** on top of the original Stage-1 spec during design review (mockup reconciliation + client decisions). These are the deltas to build; the base endpoints (feed, profiles, engagement, signup, publish, etc.) are unchanged. See `api-contract.md` for full request/response shapes and `screen-api-map.md` for which screens use each.

Status: `[ ]` to build · `[~]` in progress · `[x]` done.

---

## 1. Database schema

- [ ] **`app_user`** — add notification-type prefs: `pref_new_post`, `pref_race_day`, `pref_race_result`, `pref_milestone` (bool, default `true`).
- [ ] **`notify_optin`** — restructure to mirror `follow`: surrogate `id` PK + nullable `trainer_id` / `horse_id` + `CHECK num_nonnulls(trainer_id, horse_id) = 1` + `UNIQUE(user_id, trainer_id, horse_id)`. Drop the old `(user_id, horse_id)` composite PK.
- [ ] **`notify_optin` indexes** — `idx_notify_optin_user`, `idx_notify_optin_horse`, `idx_notify_optin_trainer`.
- [ ] *(context — done earlier this pass)* `race` split into **`race`** (event) + **`race_horse`** (runner); `trainer` gained `stable_name`/`location`/`status`; `horse.training_status` gained `retired`; `reaction.emoji` set = 👍❤️👏🙏🔥💪🐎; `notification.type` = `new_post`/`race_day`/`race_result`/`milestone`.

## 2. Member endpoints

- [ ] **`PATCH /api/me`** — edit own profile (`name`, `phone`) + notification-type toggles (`prefs.{newPost,raceDay,raceResult,milestone}`). Email/password stay in Supabase Auth. → 200 · 400 · 401.
- [ ] **`GET /api/me`** — extend response to include `prefs`.
- [ ] **`[PG] notify_optin`** — accept **horse OR trainer** (`{ horseId? , trainerId? }`, exactly one). → 201 · 204 · 401 · 422.
- [ ] **`POST /api/auth/signup`** — no API change, but the **trial-start form now collects a password** (FE); confirm validation.

## 3. Billing — embedded, no Stripe redirect

- [ ] **`POST /api/subscription/checkout`** — change from hosted Checkout Session to: create Stripe **Customer** + **Subscription (`incomplete`)** + **PaymentIntent**; return `{ clientSecret, publishableKey, subscriptionId }`. **No redirect.** → 200 · 401 · 409 · 502.
- [ ] **FE embedded Payment Element** — mount Stripe Elements (card / Apple Pay / Google Pay); `stripe.confirmPayment(clientSecret)`; card data browser→Stripe only.
- [ ] **`POST /api/subscription/cancel`** — cancel at period end (replaces the hosted Billing Portal). → 200 · 401 · 409.
- [ ] **`POST /api/subscription/payment-method`** *(optional)* — SetupIntent to update card inline. → 200 · 401.
- [ ] **`POST /api/webhooks/stripe`** — handle `payment_intent.succeeded` / `invoice.paid` → `status=active` + store Stripe ids + `current_period_end`; cancel/fail → `canceled`/`lapsed`.
- [ ] **Remove** `POST /api/subscription/portal` (hosted redirect) from the build.

## 4. Admin endpoints

- [ ] **`GET /api/admin/race-day`** — dashboard content queue: upcoming races in window (default 24h) → `race` + `race_horse` + `horse` + `trainer`, each runner with `lastPostAt` + `hasPost`. Params `?window=`, `?hasPost=`. → 200 · 401 · 403.
- [ ] **`GET /api/admin/posts?q=`** — add free-text search (title/body/horse/trainer) to the posts list. → 200 · 401 · 403.
- [ ] **`DELETE /api/admin/posts/:id`** — discard a **draft** only (hard delete; `409` if not a draft). → 204 · 401 · 403 · 404 · 409.
- [ ] *(context)* `analytics` "quiet horses" grain = horses idle > 7 days.

## 5. Behavior / cross-cutting

- [ ] **Single-device login** — on every successful sign-in, revoke the user's other Supabase sessions (service role) so the previous device is logged out; prune other `device_token`s so push targets the active device.
- [ ] **No Devices & Sessions UI** — account surface keeps a single **Sign out** (no session list / "sign out everywhere"). (`device_token` stays — push infra only.)
- [ ] **Push dispatch gating** — recipients = `notify_optin` on the **horse or its trainer** **AND** the user's `pref_*` for that event type is on.
- [ ] **race-day sweep (cron)** — ~2h before `race.scheduled_at`, join `race_horse` → `notify_optin` → fire `race_day` (needs a once-only guard so it fires per race once).
- [ ] **Media routing** — video → **Mux** (signed playback); images & voice → **Supabase Storage** (`media_url`); admin photo uploads go **direct to Storage** (client SDK), store URL only.

---

## Still open (not in scope until decided)
- [ ] Staff / super-admin role model (currently single `is_admin`).
- [ ] Final reaction emoji set (operator confirms).
- [ ] `impression` prune / rotation window.
- [ ] Licensed racing-data feed drop-in (`racing_api_id` / `racing_api_ref`).
