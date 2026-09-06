// Launch reset (ENG-984) — wipe accumulated analytics/engagement rows before
// go-live, so the numbers Mel and Justin's weeks of testing produced don't
// pollute day-one metrics. Pure, client-injected logic (no client
// construction here) so it is unit-testable against the fake — see
// `scripts/reset-analytics.mjs` for the human-run CLI wrapper.
//
// SCOPE: these are ENGAGEMENT / ANALYTICS ROWS ONLY. No `post`, `app_user`,
// `subscription`, `horse` or `trainer` ROW is ever deleted — this reset does
// not remove content or accounts, only the activity recorded against them.
//
// ONE WRITE HAPPENS OUTSIDE THESE TABLES, and it is intended. Deleting
// `reaction` rows fires the BE trigger `reaction_like_count`
// (`after insert or delete ... for each row`, stablepass-be
// 20260704120001_schema.sql:316), whose SECURITY DEFINER body runs
// `update post set like_count = greatest(0, like_count - 1)`. So clearing
// reactions drives `post.like_count` to 0 rather than leaving it stale — which
// is what launch wants, but it IS a write to `post` and must be stated. Note
// it is one UPDATE per deleted reaction row, so the delete is not a cheap bulk
// operation. (`reaction_pin_identity` only guards UPDATEs and does not block
// this.)
//
// `follow` is deliberately EXCLUDED even though it is engagement-shaped: a
// follow is member STATE (who currently follows which horse), not an
// analytics row. Wiping it would silently unfollow real members, which is a
// product change, not an analytics reset.
import type { SupabaseClient } from "@supabase/supabase-js";

export const RESET_TABLES = ["impression", "reaction", "bookmark", "trainer_website_click"] as const;

// The timestamp column each reset table is deleted on. `impression` uses
// `seen_at` and `trainer_website_click` uses `clicked_at`; the other two use
// `created_at`.
export const TS_COLUMN: Record<(typeof RESET_TABLES)[number], string> = {
  impression: "seen_at",
  reaction: "created_at",
  bookmark: "created_at",
  trainer_website_click: "clicked_at",
};

export type ResetPlan = { table: string; rows: number }[];

/**
 * Count rows per reset table. Read-only — issues no mutation.
 *
 * Each count selects the table's own TIMESTAMP COLUMN, not `*`, so the
 * pre-flight validates the exact column the delete will filter on. Counting
 * `*` would only prove the table exists: a wrong or missing timestamp column
 * on the LAST table would then surface after the first three were already
 * deleted, leaving a half-cleared database.
 */
export async function planReset(sb: SupabaseClient): Promise<ResetPlan> {
  const plan: ResetPlan = [];
  for (const table of RESET_TABLES) {
    const { count, error } = await sb
      .from(table)
      .select(TS_COLUMN[table], { count: "exact", head: true });
    if (error) {
      throw new Error(
        `reset plan: could not count "${table}" on its delete column "${TS_COLUMN[table]}": ${error.message}`,
      );
    }
    plan.push({ table, rows: count ?? 0 });
  }
  return plan;
}

/**
 * Always builds the plan first. Without `opts.confirm === true` this performs
 * NO mutation at all — the plan is returned for a dry-run / preview and
 * `deleted` is `false`. Only when explicitly confirmed does it delete, one
 * table at a time in `RESET_TABLES` order.
 */
export async function runReset(
  sb: SupabaseClient,
  opts: { confirm: boolean },
): Promise<{ plan: ResetPlan; deleted: boolean }> {
  const plan = await planReset(sb);
  if (opts.confirm !== true) return { plan, deleted: false };

  for (const table of RESET_TABLES) {
    const tsColumn = TS_COLUMN[table];
    const { error } = await sb.from(table).delete().gte(tsColumn, "1970-01-01T00:00:00Z");
    if (error) throw new Error(`reset: could not delete rows from "${table}": ${error.message}`);
  }

  return { plan, deleted: true };
}
