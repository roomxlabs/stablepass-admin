# StablePass — Screen → API Map

Every mockup screen → the actions it performs → the API each action calls → HTTP status codes → coverage.
Derived from `docs/dev-handover/mockups/` (mobile · web · admin) against the API contract in `api-contract.md`.

**Legend**
- `[PG]` — direct **PostgREST** read/write under RLS (Layer A) · `/api/…` — custom endpoint (Layer B) · **Auth** — Supabase Auth SDK (session; no HTTP status in our contract).
- **Coverage:** ✅ in the contract · ☑️ on the build checklist — new endpoint, already documented in `design.html` (see `implementation-checklist.md`) · ✅✳️ decision resolved a mockup discrepancy · ❌ still a gap.

**Cross-cutting (not repeated per row)**
- Every call carries a Supabase **JWT** (`auth.uid()`).
- Content reads are **subscription-gated** → `402` when lapsed; hidden content → `404` (never 403).
- **Single-device login** — a new sign-in revokes the user's other sessions and prunes other `device_token`s.
- **Media:** video → **Mux** (signed playback); images & voice → **Supabase Storage**.
- **Billing:** embedded **Stripe Elements** — no hosted redirect; card data goes browser→Stripe, never our backend.

**Status key:** `200` OK · `201` created · `204` no content · `400` validation · `401` no/invalid JWT · `402` subscription gate · `404` not found/hidden · `409` conflict · `422` follow/notify neither-or-both · `429` rate-limited · `502` Stripe/Mux upstream.

---

## 📱 Mobile (`mockups/index.html`)

### 01 · Splash
| Action | API | Status | Cov |
|---|---|---|---|
| Check session on boot | `GET /api/me` | 200 · 401 | ✅ |

### 02 · Sign in
| Action | API | Status | Cov |
|---|---|---|---|
| Email/pw + Apple/Google/Facebook | **Auth** SDK | session · 400 | ✅ |
| First social login → provision | `POST /api/auth/bootstrap` | 200 · 201 · 401 | ✅ |

### 03 · Onboarding — pick horses
| Action | API | Status | Cov |
|---|---|---|---|
| Load pickable horses/trainers | `[PG] GET horse` / `trainer` | 200 · 401 · 402 | ✅ |
| Follow selected (min 2) | `[PG] INSERT follow` | 201 · 401 · 422 · 409 | ✅ |

### 04 · Explore feed
| Action | API | Status | Cov |
|---|---|---|---|
| Load ranked feed | `GET /api/feed?cursor=` | 200 · 401 · 402 · 400 | ✅ |
| Record seen (scroll) | `POST /api/feed/seen` | 204 · 401 · 429 | ✅ |
| Inline "Race day · today" band | `[PG] race + race_horse` | 200 · 401 · 402 | ✅ |
| React / un-react | `[PG] upsert/delete reaction` | 201 · 204 · 401 · 400 | ✅ |
| Bookmark / un-bookmark | `[PG] insert/delete bookmark` | 201 · 204 · 401 | ✅ |

### 05 · Trainers tab
| Action | API | Status | Cov |
|---|---|---|---|
| Browse all trainers | `[PG] GET trainer` | 200 · 401 · 402 | ✅ |

### 06 · Horses tab
| Action | API | Status | Cov |
|---|---|---|---|
| Browse all horses | `[PG] GET horse` | 200 · 401 · 402 | ✅ |

### 07 · Following — my feed
| Action | API | Status | Cov |
|---|---|---|---|
| Load followed feed | `GET /api/feed/following?cursor=` | 200 · 401 · 402 | ✅ |
| Record seen | `POST /api/feed/seen` | 204 · 401 · 429 | ✅ |
| React / bookmark | `[PG] reaction` / `bookmark` | 201 · 204 · 401 · 400 | ✅ |

### 08 · Horse profile
| Action | API | Status | Cov |
|---|---|---|---|
| Profile + stats + races | `GET /api/horses/:id` | 200 · 401 · 402 · 404 | ✅ |
| Posts | `GET /api/horses/:id/feed?cursor=` | 200 · 401 · 402 · 404 | ✅ |
| Next race / race record | `[PG] race + race_horse` | 200 · 401 · 402 | ✅ |
| Follow / unfollow | `[PG] insert/delete follow {horseId}` | 201 · 204 · 401 · 422 · 409 | ✅ |
| Notify on / off | `[PG] insert/delete notify_optin {horseId}` | 201 · 204 · 401 · 422 | ✅ |
| Play video | `GET /api/posts/:id/playback` | 200 · 401 · 402 · 404 | ✅ |
| React / bookmark | `[PG] reaction` / `bookmark` | 201 · 204 · 401 · 400 | ✅ |

### 09 · Trainer profile
| Action | API | Status | Cov |
|---|---|---|---|
| Profile + their horses | `GET /api/trainers/:id` | 200 · 401 · 402 · 404 | ✅ |
| Updates | `GET /api/trainers/:id/feed?cursor=` | 200 · 401 · 402 · 404 | ✅ |
| Follow / unfollow | `[PG] insert/delete follow {trainerId}` | 201 · 204 · 401 · 422 · 409 | ✅ |
| **Notify (trainer-level) on / off** | `[PG] insert/delete notify_optin {trainerId}` | 201 · 204 · 401 · 422 | ☑️ |

### 10 · Post detail (video full-screen)
| Action | API | Status | Cov |
|---|---|---|---|
| Play (fullscreen, rotate) | `GET /api/posts/:id/playback` | 200 · 401 · 402 · 404 | ✅ |
| React / un-react | `[PG] upsert/delete reaction` | 201 · 204 · 401 · 400 | ✅ |
| Bookmark / un-bookmark | `[PG] insert/delete bookmark` | 201 · 204 · 401 | ✅ |

### 11 · Bookmarks
| Action | API | Status | Cov |
|---|---|---|---|
| Saved list (newest-first) | `[PG] GET bookmark` (join post) | 200 · 401 | ✅ |
| Remove a bookmark | `[PG] delete bookmark` | 204 · 401 | ✅ |

### 12 · Profile (Me)
| Action | API | Status | Cov |
|---|---|---|---|
| Profile + subscription + prefs | `GET /api/me` | 200 · 401 | ✅ |
| Following / Saved / unread counts | `[PG] count(follow / bookmark / notification)` | 200 · 401 | ✅ |
| **Edit profile (name, phone)** | `PATCH /api/me` | 200 · 400 · 401 | ☑️ |
| Change password | **Auth** reset | — | ✅ |
| Sign out | **Auth** `signOut` | — | ✅ |

### 13 · Notification settings
| Action | API | Status | Cov |
|---|---|---|---|
| **Type toggles (race-day/result/new-post/milestone)** | `PATCH /api/me {prefs}` | 200 · 400 · 401 | ☑️ |
| Register push token | `[PG] insert device_token` | 201 · 401 | ✅ |
| Inbox read / mark read (red-dot) | `[PG] GET / PATCH notification` | 200 · 204 · 401 | ✅ |

---

## 💻 Web (`mockups/web/index.html`)

### 01 · Marketing — stablepass.co
| Action | API | Status | Cov |
|---|---|---|---|
| Whole page (Wix, client-managed) | none | — | ✅ n/a |

### 02 · Sign in
| Action | API | Status | Cov |
|---|---|---|---|
| Login via BFF (httpOnly cookies) | **Auth** SDK | session · 400 | ✅ |
| First social login → provision | `POST /api/auth/bootstrap` | 200 · 201 · 401 | ✅ |

### 03 · Start trial
| Action | API | Status | Cov |
|---|---|---|---|
| Create trial (name, email, phone, **password**) | `POST /api/auth/signup` | 201 · 400 · 409 · 429 | ✅✳️ (password added) |

### 04 · Checkout · Stripe (embedded — no redirect)
| Action | API | Status | Cov |
|---|---|---|---|
| Create Customer + Subscription + PaymentIntent | `POST /api/subscription/checkout` → `{clientSecret}` | 200 · 401 · 409 · 502 | ✅✳️ (embedded Elements) |
| Confirm card inline (card/Apple/Google Pay) | `stripe.confirmPayment(clientSecret)` (client-side) | — | ✅ |
| Conversion (async) | `POST /api/webhooks/stripe` | 204 · 400 | ✅ |

### 05 · Onboarding — pick horses
| Action | API | Status | Cov |
|---|---|---|---|
| Load lists / follow (min 2) | `[PG] GET horse`/`trainer` · `INSERT follow` | 200 · 201 · 401 · 402 · 422 | ✅ |

### 06 · Member portal · Explore feed
| Action | API | Status | Cov |
|---|---|---|---|
| Explore / Following tabs | `GET /api/feed` · `/api/feed/following` | 200 · 401 · 402 · 400 | ✅ |
| Trainers / Horses tabs (browse) | `[PG] GET trainer` / `horse` | 200 · 401 · 402 | ✅ |
| Record seen | `POST /api/feed/seen` | 204 · 401 · 429 | ✅ |
| Inline Race Day | `[PG] race + race_horse` | 200 · 401 · 402 | ✅ |
| React / bookmark | `[PG] reaction` / `bookmark` | 201 · 204 · 401 · 400 | ✅ |
| Play video | `GET /api/posts/:id/playback` | 200 · 401 · 402 · 404 | ✅ |

### 07 · Horse profile
| Action | API | Status | Cov |
|---|---|---|---|
| Profile + posts + races | `GET /api/horses/:id` (+ `/feed`) | 200 · 401 · 402 · 404 | ✅ |
| Next race / record | `[PG] race + race_horse` | 200 · 401 · 402 | ✅ |
| Follow / Notify | `[PG] follow` / `notify_optin` | 201 · 204 · 401 · 422 · 409 | ✅ |
| Play video | `GET /api/posts/:id/playback` | 200 · 401 · 402 · 404 | ✅ |

### 08 · Account & subscription
| Action | API | Status | Cov |
|---|---|---|---|
| Load account + prefs | `GET /api/me` | 200 · 401 | ✅ |
| **Edit profile (name, phone)** | `PATCH /api/me` | 200 · 400 · 401 | ☑️ |
| **Notification prefs** | `PATCH /api/me {prefs}` | 200 · 400 · 401 | ☑️ |
| Subscribe now (embedded) | `POST /api/subscription/checkout` | 200 · 401 · 409 · 502 | ✅✳️ |
| Cancel (no hosted portal) | `POST /api/subscription/cancel` | 200 · 401 · 409 | ✅✳️ |
| Update card inline *(optional)* | `POST /api/subscription/payment-method` | 200 · 401 | ✅✳️ |
| Change password / Sign out | **Auth** SDK | — | ✅ |
| ~~Devices & Sessions~~ | removed (single-device) | — | ✅ dropped |

---

## 🛠 Admin (`mockups/web/admin/index.html`) — included for completeness
Gated: `is_admin` + login on `admin.stablepass.co` (no 2FA in this version).

### 01 · Sign in
| Action | API | Status | Cov |
|---|---|---|---|
| Email + password (is_admin gate) | **Auth** SDK | session | ✅ |

### 02 · Dashboard — content queue & race day
| Action | API | Status | Cov |
|---|---|---|---|
| Stat tiles (posts/reactions/saves/members) | `GET /api/admin/analytics` | 200 · 401 · 403 | ✅ |
| Race day · today (content queue) | `GET /api/admin/race-day` | 200 · 401 · 403 | ☑️ |
| Quiet horses (no post > 7d) | `GET /api/admin/analytics` | 200 · 401 · 403 | ✅ |
| Recently published | `GET /api/admin/posts?status=published` | 200 · 401 · 403 | ✅ |
| Edit / Unpublish (row) | `PATCH /api/admin/posts/:id` · `POST …/unpublish` | 200 · 404 · 409 | ✅ |
| Search posts/horses/trainers | `GET /api/admin/posts?q=` | 200 · 401 · 403 | ☑️ |

### 03 · Compose post
| Action | API | Status | Cov |
|---|---|---|---|
| Pick horse (searchable) | `[PG] GET horse` | 200 · 403 | ✅ |
| Upload → Mux (video) / Storage (image·voice) → draft | `POST /api/admin/posts` | 202 · 400 · 403 · 404 · 502 | ✅ |
| Edit fields | `PATCH /api/admin/posts/:id` | 200 · 404 | ✅ |
| Preview mobile + web | `GET /api/admin/posts/:id/preview` | 200 · 404 | ✅ |
| Schedule | `POST /api/admin/posts/:id/schedule` | 200 · 400 · 409 | ✅ |
| Publish now | `POST /api/admin/posts/:id/publish` | 200 · 404 · 409 | ✅ |

### 04 · Posts library
| Action | API | Status | Cov |
|---|---|---|---|
| List + status filters + search | `GET /api/admin/posts?status=&horseId=&q=` | 200 · 403 | ✅ / ☑️ (q) |
| Edit | `PATCH /api/admin/posts/:id` | 200 · 404 | ✅ |
| Unpublish / Republish | `POST …/unpublish` · `…/republish` | 200 · 409 | ✅ |
| Publish now (scheduled) | `POST /api/admin/posts/:id/publish` | 200 · 409 | ✅ |
| **Discard (draft)** | `DELETE /api/admin/posts/:id` (draft only) | 204 · 404 · 409 | ☑️ |

### 05 · Horses DB
| Action | API | Status | Cov |
|---|---|---|---|
| List + filters + follower/post counts | `[PG] GET horse` (counts derived) | 200 · 403 | ✅ |
| Add horse / edit | → form · `PATCH /api/admin/horses/:id` | 200 · 404 | ✅ |

### 06 · Add horse
| Action | API | Status | Cov |
|---|---|---|---|
| Trainer dropdown | `[PG] GET trainer` | 200 · 403 | ✅ |
| Create horse | `POST /api/admin/horses` | 201 · 400 · 403 | ✅ |
| Stats | `PATCH /api/admin/horses/:id/stats` | 200 · 404 | ✅ |
| Profile photo upload | **Supabase Storage** (direct) | — | ✅ |

### 07 · Trainers DB
| Action | API | Status | Cov |
|---|---|---|---|
| List + filters (+ email via contact) | `[PG] GET trainer` (+ `trainer_contact`) | 200 · 403 | ✅ |
| Add / edit | `POST /api/admin/trainers` · `PATCH …/:id` | 201 · 200 · 404 | ✅ |

### 08 · Add trainer
| Action | API | Status | Cov |
|---|---|---|---|
| Create trainer | `POST /api/admin/trainers` | 201 · 400 · 409 | ✅ |
| Contacts (trainer + staff) | `POST /api/admin/trainers/:id/contacts` (per contact) | 201 · 404 | ✅ |
| Profile photo upload | **Supabase Storage** (direct) | — | ✅ |

---

## Coverage result

- **No open API gaps** across mobile, web, or admin — every screen action maps to an endpoint.
- **☑️ on the build checklist (new gap-fill endpoints, already in `design.html`):** `PATCH /api/me` (profile + notification prefs), trainer-level `notify_optin`, `GET /api/admin/race-day`, `?q=` admin search, `DELETE /api/admin/posts/:id` (draft discard).
- **✅✳️ decisions that resolved mockup discrepancies:** (1) trial sign-up now collects a **password**; (2) checkout is **embedded Stripe Elements** with **no hosted redirect** — including its consequences `POST /api/subscription/checkout` (client secret), `POST /api/subscription/cancel` (replaces the hosted Billing Portal) and optional `POST /api/subscription/payment-method`.
- **Removed:** the Account "Devices & Sessions" panel (single-device login makes it moot).
