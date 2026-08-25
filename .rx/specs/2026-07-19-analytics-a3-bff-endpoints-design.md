# Analytics v1 — A3 · admin · BFF endpoints (ENG-275)

Epic: ENG-272 · Base branch: `feature/analytics-v1` · Blocked by: ENG-273 (RPCs) · Blocks: ENG-276 (UI)

## Scope
Admin BFF routes wrapping the A1 RPCs. Pure endpoints; existing `GET /api/admin/analytics` (dashboard tiles) untouched.

## Surface
`app/api/admin/analytics/{opens,engagement,trials,clicks}/route.ts`, `app/api/admin/analytics/posts/[id]/route.ts`, `lib/analytics/queries.ts`, `lib/analytics/csv.ts`, tests beside each route (mock `@/lib/supabase/server`; reuse `lib/testing/supabase-fake.ts`).

## Contract
All: `requireAdmin()` preamble (401/403) + envelope. `?period=7d|30d|all` → `p_since` (null = all); invalid → 400.
- `GET opens` → `ok({ byDay:[{day,opens}], byHour:[{hour,opens}] })` (hour UTC; FE converts)
- `GET engagement` → `ok({ trainers, horses, topPosts })` (A1 shapes, camelCased)
- `GET trials` → `ok({ byMonth:[{month,started,converted}], list:[{name,email,startedAt,endsAt,daysLeft,status}] })`
- `GET trials?format=csv` → `text/csv` attachment `stablepass-trials-<date>.csv`, columns name,email,trial_start,trial_end,status
- `GET clicks` → `ok({ trainers:[{trainerId,name,clicks,lastClick}] })` — aggregates only, NO user-level fields (compliance decision)
- `GET posts/:id` → `ok({ post:{id,title,horseName,trainerName,type,publishedAt}, opensByDay, reactionsByEmoji, saves, opens, reach })`; unknown → 404

## Guardrails
403 non-admin on every route (tested) · click responses carry no member identity · trials list = sole member-PII response, admin-gated.

## Acceptance
Per route: 403 test + happy-path shape test; CSV asserts header + content-type. `npm run typecheck && npm test` green.
