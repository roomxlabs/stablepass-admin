# Racing feed v1 — RF4 · admin · Racing match queue (ENG-296)

**Epic:** ENG-292 · **Base branch:** `feature/racing-feed-v1` · **Blocked-by:** ENG-293 (the `horse_match_proposal` table; build against seeded rows — no RF3 dependency)
**Grilled:** 20 Jul 2026.

## Why

The one-time human gate of the feed: Justin reviews proposed horse↔feed matches and confirms or rejects. A confirm writes `horse.racing_api_id`; from then on that horse's races auto-ingest and auto-appear to members (locked guardrail carve-out — see stablepass-be `.rx/guardrails.md` after RF1).

## Surface (owns)

* `app/(dash)/racing-matches/**` (new screen)
* `app/(dash)/layout.tsx` — nav entry append ONLY (shared-surface: the responsive epic owns shell layout; coordinate at integrate time)
* `app/api/admin/racing-matches/route.ts` (GET pending)
* `app/api/admin/racing-matches/[id]/route.ts` (PATCH confirm / reject)
* Route + e2e tests per repo convention

## Contract

* GET → pending proposals, platform horse (`display_name`, `racing_name`, sire, dam, `foaling_year`, trainer) side by side with feed evidence (`name, sire, dam, age, sex, colour, trainer`). `requireAdmin()`: 401 no session, 403 non-admin.
* PATCH `{ action: 'confirm' }` → `horse.racing_api_id = proposal.racing_api_id`, proposal confirmed + `resolved_at`. Horse already linked to a different id → 409, no overwrite.
* PATCH `{ action: 'reject' }` → rejected + `resolved_at`; unique `(horse_id, racing_api_id)` means the pair never re-proposes.
* Empty state: "No pending matches." Loading/error per admin patterns.

## Guardrails

`requireAdmin()` both routes (403 test mandatory). Proposals admin-only (RLS enforces too). **No owner names displayed anywhere** (evidence excludes the feed's `owner` field by contract). No odds identifiers.

## Design

No mockup (`.rx/mockups.md` has no racing entry) — styled to the admin design system, alerts-inbox precedent. Card per proposal with confirm/reject.

## Acceptance

* 403 non-admin on both routes; happy-path confirm sets `racing_api_id` (seeded proposal).
* Reject resolves and stays resolved.
* Already-linked confirm → 409 without overwrite.
* Empty state renders. Repo gate green.

## Out of scope

`app/(dash)/horses/**` (responsive epic owns). Manual racing_api_id entry on the horse form. The poll (RF3).
