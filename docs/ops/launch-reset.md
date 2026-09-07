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

## Where the safety gates are tested

Both gates are **behaviourally tested**, not asserted as source text. The
script (`scripts/reset-analytics.mjs`) is a thin effect wrapper; all of its
logic — argument parsing, ref derivation, and both gates — lives in
`scripts/reset-analytics.core.mjs`, which `lib/analytics/reset.test.ts`
imports and drives against a fake client.

What is pinned:

| Gate | Test proves |
|---|---|
| Dry run is the default | a run **without** `--confirm` issues **zero** deletes |
| `--confirm` | deletes **only** the four reset tables, each on its own timestamp column |
| `--project-ref` missing | refuses, deletes nothing, and **opens no client at all** |
| `--project-ref` mismatched | refuses, deletes nothing, opens no client |
| Mismatch message | does not echo the derived ref or the host (type-to-confirm, not copy-paste) |
| Post-delete re-count | non-zero exit if any row survives |

Deleting either gate turns the suite **red** — verified by mutation
(`if (!confirm)` → `if (false)` and `if (!projectRef || ...)` → `if (false)`).
The earlier version of this test only checked that two strings appeared in the
script's source, which survived both of those mutations.

## Operational limit: 100,000 rows per table per analytics read

Not part of the reset, but the same launch-day concern, so it is recorded here.

`lib/analytics/admin-exclusion.ts` pages every engagement read at
`PAGE_SIZE` 1,000 with a `MAX_BATCHES` runaway guard of 100 — a hard ceiling of
**100,000 rows per table per read**.

`impression` is primary-keyed `(user_id, post_id)`, so it grows as
*members × posts* and will reach this first. On crossing it, `fetchAllRows`
**throws**, and because every analytics endpoint and the dashboard read through
it, they all return 500 until the limit is raised.

This is deliberate — a silently truncated aggregate reported as fact is worse
than an outage — but it is a real ceiling. **Raising it means pushing the
aggregation into SQL** (a `join app_user au on au.id = <t>.user_id where not
au.is_admin` inside the `admin_*` RPCs, the shape `admin_trials_by_month`
already uses), not bumping the constant: 200 batches of serial round-trips
would time out long before it helped. That is a `stablepass-be` change.

Rough headroom check: at 500 members and 200 posts, `impression` tops out near
100,000 — so this should be tracked as the member count grows, not filed away.

### Known residual: offset paging is not a consistent snapshot

The paging in `lib/analytics/admin-exclusion.ts` orders every batch on the
table's unique key, which removes scan-order nondeterminism. It does **not**
make a multi-batch read a consistent snapshot: it is still offset paging, so a
row inserted concurrently that sorts *before* the current offset shifts later
rows and the next batch skips one.

Impact is bounded — roughly one row per extra batch, and only on a table with
more than 1,000 matching rows in the period — but it is real, since mobile
clients insert `impression` rows continuously.

The fix is keyset paging (carry the last `(user_id, post_id)` and filter with
`.or("user_id.gt.<u>,and(user_id.eq.<u>,post_id.gt.<p>)")`), which the existing
sort-key registry already supplies. Deferred deliberately: it changes the query
issued on all six analytics endpoints and cannot be proven against a real
PostgREST by either the unit fake or the e2e mock. Worth doing once the first
engagement table routinely exceeds one page.
