# Marketing visibility toggle (W8) — design spec

Epic: ENG-721 (Waitlist cutover). Ticket: ENG-766. Added 24 Aug after the dynamic-strip decision change.
Base branch: `main`. Cross-epic collision: this lands BEFORE ENG-746 (R6, round-6 epic), which also owns
TrainerForm.tsx; ENG-746 is blocked-by this and rebases.

## Why
The marketing trainer strip reads live from `public_trainer` (W7/ENG-765). Admin needs the switch that
puts a trainer on the public site and makes their photo publicly servable.

## Scope
1. TrainerForm checkbox "Show on marketing site" (default off; independent of app Visibility/status).
   Helper copy: publishes name, location, bio, horses and photo on stablepass.co.
2. Routes: `marketingVisible` in POST insert + PATCH FIELD_MAP + select echo.
3. Photo publish: on save with toggle ON (or photo change while ON), the admin browser client copies the
   private trainer photo into `marketing-photos` at `trainers/<trainerId>.<ext>` (signed download from the
   private bucket, upload to the public bucket, both direct-to-storage) and PATCHes `marketingPhotoPath`.
   Toggle OFF: delete the public object + null the path.
4. Copy failure never blocks the save: path stays null, retryable warning, site shows the initials disc.
5. Trainers list page: an "On site" badge for visible trainers.

## Surface
```
app/(dash)/trainers/TrainerForm.tsx        (before ENG-746)
app/(dash)/trainers/page.tsx               (badge)
app/api/admin/trainers/route.ts
app/api/admin/trainers/[id]/route.ts
route + form test files
```

## Guardrails
requireAdmin() intact; public bucket is admin-write-only (W7 policies); nothing from trainer_contact near
this flow; only the marketing-approved photo is copied.

## Tests
Route matrix (create/patch/echo/403), form checkbox + copy-call assertions (download-from-private,
upload-to-public, PATCH path; delete + null on toggle off).

## Dependencies
Blocked by ENG-765 (on DEPLOY: columns must exist in the pointed-at project or the PATCH 42703s).
Blocks ENG-746.
