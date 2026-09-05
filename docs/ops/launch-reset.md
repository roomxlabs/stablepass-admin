# Launch reset (ENG-984)

## What it does, and why

Mel and Justin have used the app daily for weeks while it was built, so the
accumulated engagement numbers (opens, reactions, saves, website clicks) are
mostly staff activity, not member activity. Before launch, we want day-one
analytics to start from zero, not from months of internal testing.

`scripts/reset-analytics.mjs` deletes the rows in the engagement tables
listed below. `lib/analytics/reset.ts` is the tested source of truth for the
table list and per-table timestamp column; the script duplicates that small
literal (it can't import the .ts module without a TS loader) and must be kept
in step with it.

## Tables cleared

- `impression` (post opens)
- `reaction`
- `bookmark` (saves)
- `trainer_website_click`

## Tables from which NOTHING is deleted

- `post` — no post row is ever deleted. (Its `like_count` column *is* updated as
  a side effect of clearing reactions — see the section below.)
- `app_user` — accounts are not analytics.
- `subscription` — billing/trial state is not analytics.
- `horse`, `trainer` — content entities are not analytics.
- `follow` — deliberately excluded even though it looks engagement-shaped. A
  follow is member STATE (who currently follows which horse), not an
  analytics row. Wiping it would silently unfollow real members, which is a
  product change this ticket does not make.

## Required environment variables

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Both must point at the project you intend to reset. The script derives the
project ref from `SUPABASE_URL` (`https://<ref>.supabase.co` → `<ref>`; a
localhost/127.0.0.1 URL derives to `local`).

## Dry run (default)

Without `--confirm`, the script performs no mutation — it prints the row
count per table (and a total) that WOULD be deleted, then exits.

```bash
node scripts/reset-analytics.mjs --project-ref=<ref>
```

## Confirmed run

```bash
node scripts/reset-analytics.mjs --confirm --project-ref=<ref>
```

Prints the same counts, deletes the rows, then prints what was deleted.

## The `--project-ref` guard (what it does and does NOT do)

`--project-ref` is **required** and must **exactly match** the ref derived from
`SUPABASE_URL`. If it is missing or mismatched the script exits 1 without
touching anything, and it deliberately **does not print the expected ref** —
echoing it would hand over the answer and reduce the gate to a copy-paste
prompt. Take the ref from your own records.

Be clear about what this is: a **type-to-confirm**. It proves you can name the
project you are about to wipe, so a reset can never be a bare command with no
acknowledgement of the target. It does **not** independently verify that
`SUPABASE_URL` is the project you meant — it is derived from that same variable.
So if your shell holds a stale production `SUPABASE_URL`, the guard will ask for
the production ref and accept it.

**Therefore: check the `Target:` line the script prints before you type
`--confirm`.** Every run, dry or confirmed, prints the target host and ref. That
line, not the guard, is what tells you which database you are about to clear.

## This is NOT a migration

This script is run **deliberately, by a human**, once, around launch. It is
**never** wired into deploy, CI, or a database migration. Nothing in the app
or build pipeline calls it automatically.

## One intended side effect: `post.like_count` drops to 0

Clearing `reaction` fires the backend trigger `reaction_like_count`
(`after insert or delete ... for each row`, stablepass-be
`20260704120001_schema.sql:316`). Its SECURITY DEFINER body runs
`update post set like_count = greatest(0, like_count - 1)`, so **deleting the
reactions drives `post.like_count` down to 0 by itself**. No recompute step is
needed, and nothing is left stale.

Two things follow, and both are deliberate:

- This is the **only** write the reset makes outside the four tables above. No
  `post` row is deleted — only the `like_count` column moves.
- Because the trigger is per-row, the reaction delete is N individual UPDATEs on
  `post`, not a cheap bulk delete. On a large reaction table expect it to take a
  while; let it finish rather than interrupting it half-way.

Feed ordering uses `idx_post_feed on post(status, like_count desc, published_at
desc)`, so post ordering will change after the reset. That is the intended
launch-from-zero behaviour, but worth knowing before you look at the feed.

> An earlier draft of this runbook claimed `like_count` would be left stale and
> flagged it as an open decision. That was wrong — the trigger handles it. The
> claim is corrected here rather than deleted, because a destructive runbook
> that has been wrong once should show its correction.
