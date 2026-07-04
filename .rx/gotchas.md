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
