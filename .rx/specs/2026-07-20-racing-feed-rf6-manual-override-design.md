# Racing feed v1 — RF6 · admin · Manual race override, fallback (ENG-180, re-scoped)

**Epic:** ENG-292 · **Base branch:** `feature/racing-feed-v1` · **Blocked-by:** ENG-293 (entry_status default + manual_override flag)
**Re-scoped 20 Jul 2026** from the original T10 "manual race entry" (admin-dashboard epic): with the Racing API feed (RF3) primary, this is the **fallback** — pre-API history, unmatched horses, feed outages, corrections that must stick. Same stub routes, same `source='manual'` shape.

## Surface (owns)

* `app/api/admin/races/route.ts` (POST create, `source='manual'`) — existing stub
* `app/api/admin/races/[id]/route.ts` (new: PATCH correct / DELETE — works on both `manual` and `api` rows)
* `app/api/admin/races/[id]/runners/route.ts` (POST attach runner) — existing stub
* `app/api/admin/race-horses/[id]/result/route.ts` (PATCH result) — existing stub
* `app/(dash)/racing-manual/**` (minimal admin-styled UI)
* Route + e2e tests

## Contract

* **Create**: venue, race_date, race_number, race_class, distance_m, scheduled_at → `race` `source='manual'`. Natural key `(venue, race_date, race_number)` → 409 on duplicate, including vs an `api` row (never two rows for one real race).
* **Attach runner**: horse + barrier + jockey → `race_horse` `entry_status='confirmed'`. Manual rows behave identically downstream (2h sweep, pushes).
* **Result**: result text + finish_position (+ optional prize cents) → race finished + `finished_at`, runner `entry_status='ran'`, counters increment (same rules as RF3), invoke be push-dispatch `race_result`.
* **Correct/delete**: PATCH any field on any row; PATCH on an `api` row sets `race.manual_override=true` (poll stops touching it). DELETE cascades runners. UI copy: deleting an `api` race without `manual_override` may be re-created by the next poll; correct-then-delete or unlink the horse to remove permanently.

## Guardrails

`requireAdmin()` everywhere (403 tests). No odds/betting fields. No owner PII. Push via the be function.

## Design

No mockup — minimal admin-styled UI (original T10 wording; alerts-inbox precedent).

## Acceptance

* 403 non-admin on all routes.
* Create → attach → result happy path: race finished, counters incremented once, push invoked (mock).
* Duplicate natural key → 409.
* PATCH on `api` row sets `manual_override=true` (asserted).
* Repo gate green.

## Out of scope

The feed (RF3). Match queue (RF4). Member reads (RF5). Bulk history import.
