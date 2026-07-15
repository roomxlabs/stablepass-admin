# Admin local-time display & re-scheduling v1 — epic design (ENG-250)

**Repo:** stablepass-admin · **Base branch:** `feature/time-display-v1` · FE-only, no migrations.
Slices: ENG-251 LocalTime → ENG-252 posts · ENG-253 dashboard · ENG-254 compose (parallel) → ENG-255 [Gate].

## Why
Storage is correct (UTC timestamptz); display is formatted in Server Components → server TZ (UTC on
Vercel). A scheduled post's time can't be changed after creation, and the create flow's single
`datetime-local` reads as date-only on some browsers.

## Locked decisions
1. Absolute times render in the viewer's browser TZ via a shared `LocalTime` client component
   (empty `<time>` SSR shell, filled in useEffect; `dateTime` attr kept). Labels identical to today,
   browser-default locale, no TZ suffix. Relative labels (timeAgo) untouched.
2. Minute precision — no seconds (BE publisher is a cron sweep).
3. Explicit Date (`type="date"`) + Time (`type="time"`) native inputs replace `datetime-local` in the
   create flow; the same pair + current-schedule display + Update-schedule action appear in edit mode
   for draft/scheduled posts (endpoint already accepts re-scheduling). Errors inline
   (`scheduled_for_in_past`, `validation_failed`, `invalid_status`).
4. Coordination: surfaces intersect the responsive epic (ENG-244/245/246) — implement-loop
   surface-claim serializes; land this epic first. PR #10 (ComposeScreen) merges before ENG-254.

## Feature flow / API & data flow
See the epic body (ENG-250) — mermaid flowchart + sequenceDiagram are authored there verbatim.
