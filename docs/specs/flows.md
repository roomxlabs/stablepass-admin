# StablePass — Flows

Two levels: one **big-picture journey** across the whole product, then a **detailed flow per action** with the API endpoint annotated on each step. Detailed-flow names line up with the big-picture stages. A **flow → API mapping** table follows at the end.

Legend: `[PostgREST]` = direct data call under RLS · `/api/…` = custom endpoint · **404** for hidden content, **402** when the subscription gate fails.

---

## 0. Big-picture user flow (whole journey)

```mermaid
flowchart TD
    A([Visit / open app]) --> B{Have account?}
    B -- No --> C[Sign up: start 30-day no-card trial]
    B -- Yes --> D[Log in]
    C --> E[Onboarding: follow horses & trainers]
    D --> G
    E --> G[Tabs: Explore / Following feed · Trainers / Horses browse · inline Race Day]
    G --> H[Open a horse or trainer profile]
    G --> I[Open post detail: watch video, react, bookmark]
    H --> J[Follow + per-horse notify opt-in]
    I --> J
    J --> K[Receive notifications: new post / race result]
    K --> G
    G --> L{Trial ending or lapsed?}
    L -- Convert on web --> M[Stripe checkout -> active]
    L -- Ignore --> N[Trial sweep -> lapsed: content gated]
    M --> G
    N --> O[Reactivate via checkout]
    O --> M

    subgraph ADMIN [Operator surface - admin.stablepass.co]
      P[Compose: upload -> Mux -> draft] --> Q[Preview mobile + web]
      Q --> R[Publish or schedule]
      R --> K
      S[Manual race entry -> result] --> K
      T[Manage horses / trainers / contacts]
      U[Analytics: quiet horses, engagement]
    end
```

---

## 0b. Big-picture admin flow *(operator journey — `admin.stablepass.co`)*

The whole operator journey across the admin dashboard. Each detailed admin flow (sign-in, compose, race entry, manage, crons) is one stage here. Everything is gated by `is_admin`.

```mermaid
flowchart TD
    A([Go to admin.stablepass.co]) --> B[Sign in: email + password]
    B --> C{is_admin verified?}
    C -- No --> B
    C -- Yes --> D[Dashboard]
    D --> E[Helpers: quiet horses · racing today · engagement · recently published]
    D --> F[Compose a post -> Mux -> preview -> publish/schedule]
    D --> G[Posts library -> edit / unpublish / republish]
    D --> H[Horses -> add/edit, stats, journey status]
    D --> I["Races -> enter upcoming (2 paths) -> record results"]
    D --> J[Trainers -> add/edit, manage internal contacts]
    D --> K[Analytics -> engagement, quiet horses, subscribers]
    F --> L[Push fan-out to per-horse notify opt-ins]
    I --> L
    D --> M[Log out -> clears session; re-entry needs sign-in again]
```

The detailed admin flows are **9** (compose → publish), **10** (race entry), **11** (manage horses/trainers/contacts), **12** (system crons), and **13** (sign-in) below.

---

## 1. Sign-up → Trial start *(web)*

```mermaid
flowchart TD
    A([Trial start screen: name, email, phone, password]) --> B["POST /api/auth/signup"]
    B --> C{Valid & email free?}
    C -- "400 validation_failed" --> A
    C -- "409 email_taken" --> A2[Prompt to log in instead]
    C -- Yes --> D["Atomic: create auth user + app_user + subscription(status=trial, trial_ends_at=now+30d); NO card / NO Stripe"]
    D --> E["201 Created -> session established (revokes any other device's session — one device only)"]
    E --> F[Go to Onboarding]
```

## 2. Social login → bootstrap *(Apple / Google / Facebook)*

```mermaid
flowchart TD
    A([Tap Continue with Apple/Google/Facebook]) --> B[Provider consent -> Supabase OAuth exchange]
    B --> C["Supabase mints JWT pair - revokes user's other sessions (one device only)"]
    C --> D{First time?}
    D -- Yes --> E["DB trigger on auth.users insert (service role) — or POST /api/auth/bootstrap: ensure app_user + trial subscription, idempotent"]
    D -- No --> F[Existing app_user + subscription]
    E --> G[Authenticated]
    F --> G
    G --> H{New signup?}
    H -- Yes --> I[Onboarding]
    H -- No --> J[Feed]
```

> App Store rule: because Google/Facebook are offered, **Sign in with Apple is mandatory on iOS**.

## 3. Onboarding — follow horses & trainers

```mermaid
flowchart TD
    A([Onboarding: pick horses/trainers, with Select all]) --> B["Browse lists [PostgREST] trainer / horse (gated)"]
    B --> C[Select targets]
    C --> D["Insert follow rows [PostgREST] follow — CHECK exactly one of (trainerId, horseId)"]
    D --> E{Exactly one target per row?}
    E -- "422 / 409" --> C
    E -- OK --> F[Done -> land on Explore feed]
```

## 4. Feed & browse *(top tabs: Explore · Trainers · Horses · Following)*

The top tab bar has four tabs. **Explore** and **Following** are the two *ranked feed* views; **Trainers** and **Horses** are *browse* lists. **Race Day** is not a tab — it's an inline "today's racing" band woven into the Explore/Following feed (per the mockup).

```mermaid
flowchart TD
    A(["Top tab bar: Explore | Trainers | Horses | Following"]) --> B{Tab?}
    B -- Explore --> C["GET /api/feed?cursor= (ranked: like-weight + recency + unseen-first)"]
    B -- Following --> D["GET /api/feed/following?cursor="]
    B -- Trainers --> T["Browse all [PostgREST] trainer list -> tap -> Trainer profile"]
    B -- Horses --> U["Browse all [PostgREST] horse list -> tap -> Horse profile"]
    C --> RD["Inline 'Race day - today' band: [PostgREST] race + race_horse (today's runners/results) woven into the feed"]
    D --> RD
    C --> F{Subscription trial/active?}
    D --> F
    T --> F
    U --> F
    F -- "402 subscription_required" --> G[Prompt to reactivate -> Checkout]
    F -- Yes --> H[Render items; feed records impressions for returned posts]
    H --> I[Scroll: batch new impressions]
    I --> J["POST /api/feed/seen { postIds[] }"]
    J --> K[Seen posts sink on next load]
    H --> L[Tap a post -> Post detail]
    H --> M[Tap a horse/trainer -> Profile]
```

## 5. Post detail — watch, react, bookmark

```mermaid
flowchart TD
    A([Open post detail]) --> B{Video?}
    B -- Yes --> C["GET /api/posts/:id/playback -> mint short-lived Mux signed URL (subscription re-checked at mint)"]
    C --> D{Gate ok?}
    D -- "402" --> Z[Blocked -> reactivate]
    D -- Yes --> E[Play fullscreen; rotate for landscape]
    B -- No --> E2[Render photo / text / voice / news]
    E --> F[React]
    E2 --> F
    F --> G["Upsert reaction [PostgREST] reaction { postId, emoji } — increments post.like_count"]
    A --> H[Bookmark]
    H --> I["Insert [PostgREST] bookmark { postId }"]
    F --> J[Un-react -> delete reaction, decrement like_count]
```

## 6. Follow & per-horse notify opt-in

```mermaid
flowchart TD
    A([On a horse/trainer profile]) --> B[Tap Follow]
    B --> C["Insert follow [PostgREST] { trainerId? | horseId? } (exactly one)"]
    C --> D[Now appears in Following feed]
    A --> E[Toggle Notify me - horse OR trainer]
    E --> G["Insert/delete notify_optin [PostgREST] { horseId? | trainerId? } (exactly one) — independent of follow"]
    G --> H[Push alerts for this horse/trainer, gated by app_user type prefs]
    B --> I[Unfollow -> delete follow row]
```

## 7. Subscription checkout → conversion *(web only)*

```mermaid
flowchart TD
    A([Trial ending / Account -> Subscribe]) --> B["POST /api/subscription/checkout"]
    B --> C{Already active?}
    C -- "409 already_active" --> Z[Already subscribed]
    C -- Ok --> D["Create Stripe customer + subscription(incomplete) + PaymentIntent"]
    D --> E["200 { clientSecret } — NO redirect"]
    E --> F["Embedded Stripe Elements form in-app (card / Apple Pay / Google Pay)"]
    F --> G["stripe.confirmPayment(clientSecret) — card goes browser -> Stripe (never our backend)"]
    G --> H["Stripe -> POST /api/webhooks/stripe (signature-verified, service role)"]
    H --> I["payment_intent.succeeded / invoice.paid: status=active, store stripe ids + current_period_end"]
    I --> J[Full access as paying subscriber]
    G --> K[Card declined -> inline error, retry on same form]
```

## 8. Notifications — receive & read

```mermaid
flowchart TD
    A([Content event]) --> B{Type?}
    B -- New post published --> C["new_post -> horse's notify opt-ins"]
    B -- "Race ~2h out (cron)" --> C2["race_day reminder -> notify opt-ins"]
    B -- Race result recorded --> D["race_result -> notify opt-ins"]
    B -- "First win / retirement" --> D2["milestone -> notify opt-ins"]
    C --> E["push dispatch: recipients = notify_optin (horse or trainer) AND app_user pref for this type is on -> Expo Push to device_tokens + notification rows (pushed=true)"]
    C2 --> E
    D --> E
    D2 --> E
    E --> F[Device receives push]
    A2([General feed activity]) --> G[In-app red-dot only — NO push]
    F --> H["Open app -> notification inbox [PostgREST] notification (own rows)"]
    G --> H
    H --> I["Mark read [PostgREST] PATCH notification.read=true -> clears red-dot"]
    H --> J[Tap -> deep-link to target post/race/horse]
```

## 9. Admin — compose → publish / schedule

```mermaid
flowchart TD
    A([Admin: Compose]) --> B["Select HORSE (searchable) — trainer inferred from horse"]
    B --> C["POST /api/admin/posts (multipart) { horseId, type, title?, sourceTrainerId, expiresAt? }"]
    C --> D{Admin + horse valid?}
    D -- "403 / 404 horse_not_found" --> A
    D -- "502 mux_unavailable" --> A
    D -- Ok --> E["202 Accepted: push to Mux, watermark, create post(status=draft)"]
    E --> F["watermarked -> true & asset ready (video=Mux, image/voice=Supabase Storage)"]
    F --> G["GET /api/admin/posts/:id/preview (mobile + web)"]
    G --> H{Publish now, later, or discard?}
    H -- Discard draft --> DD["DELETE /api/admin/posts/:id (draft only, hard delete)"]
    H -- Now --> I["POST /api/admin/posts/:id/publish -> published, published_at, new_post fan-out"]
    H -- Later --> J["POST /api/admin/posts/:id/schedule { scheduledFor } -> scheduled"]
    J --> K["cron: scheduled-post publisher flips scheduled -> published at scheduled_for, fires fan-out"]
    I --> L[Live in Explore + Following]
    K --> L
    L --> M["POST /api/admin/posts/:id/unpublish -> soft hide (reversible)"]
    M --> N["POST /api/admin/posts/:id/republish -> published"]
```

## 10. Admin — race entry (two paths) → result

Normalised `race` **event** + `race_horse` **runner**, so the admin can enter a race **from a horse** or **from a race**. Both converge on the same `race_horse` row.

```mermaid
flowchart TD
    subgraph P1 [Path A - horse-first from the horse page]
      A([This horse is racing]) --> B["POST /api/admin/horses/:id/races { venue, raceDate, raceNumber, raceClass, distanceM, scheduledAt, barrier, jockey }"]
      B --> C{Event exists? dedup venue+date+number}
      C -- No --> D[Create race event status=upcoming]
      C -- Yes --> E[Reuse existing event]
      D --> F["Add race_horse runner {barrier, jockey}"]
      E --> F
    end
    subgraph P2 [Path B - race-first]
      G([Create a race]) --> H["POST /api/admin/races {venue, raceDate, raceNumber, raceClass, distanceM, scheduledAt}"]
      H --> I["201: race event"]
      I --> J["POST /api/admin/races/:id/runners {horseId, barrier, jockey} (repeat per platform horse)"]
      J --> F
    end
    F --> K[Runner shows in Race Day feed + horse Next race card]
    K --> L["cron race-day sweep ~2h before scheduled_at: race -> race_horse -> notify_optin -> race_day reminder"]
    F --> M[After the race runs, enter each runner's result]
    M --> N["POST /api/admin/race-horses/:id/result {result} -> race_result fan-out to that horse's opt-ins"]
    N --> O[Event flips finished when runners done; notificationsSent returned]
```

## 11. Admin — manage horses, trainers & contacts

```mermaid
flowchart TD
    A([Admin]) --> B[Add trainer]
    B --> C["POST /api/admin/trainers { name, slug, bio?, photoUrl? }"]
    A --> D[Add horse]
    D --> E["POST /api/admin/horses { trainerId, sire, dam, sex?, colour?, foalingYear?, stableName? }"]
    A --> F[Edit horse]
    F --> G["PATCH /api/admin/horses/:id { trainingStatus, status, racingName, ... }"]
    F --> H["PATCH /api/admin/horses/:id/stats { starts, wins, places, prizeMoneyCents }"]
    A --> I[Trainer contacts - internal, admin-only]
    I --> J["POST /api/admin/trainers/:id/contacts / PATCH|DELETE /api/admin/contacts/:id"]
    A --> K[Dashboard & analytics]
    K --> KD["GET /api/admin/race-day (content queue: races next 24h + last-post recency)"]
    K --> L["GET /api/admin/analytics (quiet horses, engagement) · GET /api/admin/subscribers?status="]
```

## 12. System — scheduled jobs *(cron, service role)*

```mermaid
flowchart TD
    A([cron tick]) --> B[scheduled-post publisher]
    B --> C["Find posts status=scheduled AND scheduled_for <= now"]
    C --> D["Set status=published, stamp published_at, fire new_post fan-out"]
    A --> E[trial-sweep - nightly]
    E --> F["Find subscription status=trial AND trial_ends_at <= now"]
    F --> G["Set status=lapsed -> content reads denied by RLS"]
    A --> R[race-day sweep]
    R --> S["race status=upcoming AND scheduled_at ~2h out"]
    S --> T["join race_horse -> notify_optin -> race_day reminder per running horse"]
    A --> H["poll-racing-api (FUTURE, contingent on licensed feed)"]
    H --> I["find-or-create race(api) + race_horse via racing_api_id -> race_result fan-out"]
```

## 13. Admin — sign in

The gate to all admin flows (9–12). Handled by **Supabase Auth** (not a custom endpoint). The `is_admin` flag is what separates the operator from a subscriber; the admin surface lives at `admin.stablepass.co`.

```mermaid
flowchart TD
    A([admin.stablepass.co]) --> B[Enter email + password]
    B --> C[Supabase Auth verifies credential]
    C -- bad credential --> B
    C -- Yes --> D{is_admin = true?}
    D -- No --> E[No admin access -> redirected / 403]
    D -- Yes --> F["Token pair minted with is_admin=true claim"]
    F --> G[Reach dashboard; RLS treats caller as admin]
    G --> H[Log out -> clears session; re-entry needs sign-in again]
```

Notes: the admin is a normal `app_user` row with `is_admin = true` — there is no separate admin identity. Login/logout/refresh are all Supabase Auth via the SDK, and every admin sign-in attempt is audited. **2FA (TOTP) is deferred** — not in this version; it can be layered on the admin login later without touching the data model.

---

## Flow → API mapping

| Flow | Step | Method · Endpoint | Data touched |
|---|---|---|---|
| 1 Sign-up | Create trial account | `POST /api/auth/signup` | `app_user`, `subscription(trial)` |
| 2 Social login | First-login bootstrap | `POST /api/auth/bootstrap` *(or DB trigger)* | `app_user`, `subscription(trial)` |
| — | Profile + gate summary | `GET /api/me` | `app_user`, `subscription`, prefs |
| — | Edit profile + notif prefs | `PATCH /api/me` | `app_user` (name, phone, pref_*) |
| 3 Onboarding | Browse lists | `[PostgREST] GET trainer` / `horse` | `trainer`, `horse` |
| 3 Onboarding | Follow selected | `[PostgREST] INSERT follow` | `follow` |
| 4 Feed | Explore tab | `GET /api/feed` | `post`, `horse`, `trainer`, `impression`, `reaction`(reacted), `bookmark` |
| 4 Feed | Following tab | `GET /api/feed/following` | `post`, `follow` |
| 4 Feed | Trainers / Horses tabs (browse) | `[PostgREST] GET trainer` / `horse` list | `trainer`, `horse` |
| 4 Feed | Race Day (inline band) | `[PostgREST] race + race_horse` + race-result `post` | `race`, `race_horse`, `post` |
| 4 Feed | Record impressions | `POST /api/feed/seen` | `impression` |
| 5 Post detail | Video playback URL | `GET /api/posts/:id/playback` | `post`, `subscription` (re-gate), Mux |
| 5 Post detail | React / un-react | `[PostgREST] upsert/delete reaction` | `reaction`, `post.like_count` |
| 5 Post detail | Bookmark | `[PostgREST] insert/delete bookmark` | `bookmark` |
| 6 Follow/notify | Follow / unfollow | `[PostgREST] follow` | `follow` |
| 6 Follow/notify | Notify opt-in (horse or trainer) | `[PostgREST] notify_optin` | `notify_optin` |
| 7 Checkout | Create checkout | `POST /api/subscription/checkout` | `subscription`, Stripe |
| 7 Checkout | Conversion webhook | `POST /api/webhooks/stripe` | `subscription(active)` |
| 7 Checkout | Confirm payment (embedded) | `stripe.confirmPayment(clientSecret)` (client-side) | Stripe (card never hits backend) |
| 7 Checkout | Cancel (no hosted portal) | `POST /api/subscription/cancel` | `subscription(canceled)` |
| 8 Notifications | Read inbox | `[PostgREST] notification` | `notification` |
| 8 Notifications | Mark read | `[PostgREST] PATCH notification` | `notification.read` |
| 8 Notifications | Register device | `[PostgREST] device_token` | `device_token` |
| 9 Admin content | Upload → draft | `POST /api/admin/posts` | `post(draft)`, Mux |
| 9 Admin content | Preview | `GET /api/admin/posts/:id/preview` | `post` |
| 9 Admin content | Review queue / library / search | `GET /api/admin/posts?status=&q=` | `post` |
| 9 Admin content | Discard draft | `DELETE /api/admin/posts/:id` (draft only) | `post` (hard delete) |
| 9 Admin content | Edit | `PATCH /api/admin/posts/:id` | `post` |
| 9 Admin content | Publish | `POST /api/admin/posts/:id/publish` | `post(published)`, `notification` fan-out |
| 9 Admin content | Schedule | `POST /api/admin/posts/:id/schedule` | `post(scheduled)` |
| 9 Admin content | Unpublish / republish | `POST …/unpublish` · `…/republish` | `post(unpublished/published)` |
| 10 Admin race | Race-first: create event | `POST /api/admin/races` | `race(upcoming)` |
| 10 Admin race | Race-first: attach runner | `POST /api/admin/races/:id/runners` | `race_horse` |
| 10 Admin race | Horse-first: find-or-create + attach | `POST /api/admin/horses/:id/races` | `race`, `race_horse` |
| 10 Admin race | Record runner result | `POST /api/admin/race-horses/:id/result` | `race_horse(result)`, `notification` fan-out |
| 10 Admin race | Edit / delete | `PATCH`/`DELETE /api/admin/races/:id` · `/race-horses/:id` | `race`, `race_horse` |
| 11 Admin manage | New trainer / horse | `POST /api/admin/trainers` · `/api/admin/horses` | `trainer`, `horse` |
| 11 Admin manage | Edit horse / stats | `PATCH /api/admin/horses/:id` · `…/stats` | `horse` |
| 11 Admin manage | Trainer contacts | `POST /api/admin/trainers/:id/contacts` · `PATCH`/`DELETE /api/admin/contacts/:id` | `trainer_contact` |
| 11 Admin manage | Dashboard content queue | `GET /api/admin/race-day` | `race` + `race_horse` + `horse` + last-`post` recency |
| 11 Admin manage | Analytics / subscribers | `GET /api/admin/analytics` · `/api/admin/subscribers` | aggregate reads |
| 12 System | Scheduled publish | *cron* scheduled-post publisher | `post(scheduled→published)`, `notification` |
| 12 System | Trial sweep | *cron* trial-sweep | `subscription(trial→lapsed)` |
| 12 System | Race-day reminder | *cron* race-day sweep | `race(upcoming)` → `notification(race_day)` |
| 12 System | Push dispatch | *internal* on publish/result | `device_token`, `notification` |
| 13 Admin sign-in | Email + password | *Supabase Auth (SDK)* — no custom endpoint | `app_user.is_admin` (claim) |
