// Admin-activity exclusion — the ONE place analytics decides whose rows count
// (ENG-984).
//
// WHY THIS EXISTS
// ---------------
// Every engagement row (`impression`, `reaction`, `bookmark`,
// `trainer_website_click`, `follow`) is keyed by `user_id -> app_user.id`, and
// operators are ordinary `app_user` rows promoted to `is_admin` after signup.
// Mel and Justin have used the app daily for weeks, so the accumulated
// engagement numbers are mostly THEM. The analytics screen is supposed to
// answer "how are members engaging", and staff are not members.
//
// ENG-314 fixed the trials cohort and ENG-315 the Members tile, but both did it
// with a bespoke per-call-site filter. Nothing covered opens, reactions, saves,
// clicks or per-post analytics, and the next endpoint would have forgotten
// again. So the rule lives here once, and every analytics read goes through
// `memberRows()` / `excludeAdminRows()`.
//
// WHY THE FILTER IS APPLIED IN TS, NOT IN SQL
// -------------------------------------------
// The aggregate numbers used to come from the `admin_*` SECURITY DEFINER RPCs
// (stablepass-be, 20260719120000_analytics.sql). Those RPCs count every row
// regardless of who produced it, and they live in another repo — this ticket is
// `repo:stablepass-admin`, so changing their SQL is not on the table here. What
// IS available is that the admin holds a plain SELECT policy on each engagement
// table (`impression_select_admin`, `reaction_select_admin`,
// `bookmark_select_admin`, `trainer_website_click_select_admin`), so the BFF can
// read the rows itself and aggregate them with staff removed.
//
// Filtering in TS rather than pushing a `not.in.(...)` down to PostgREST is
// deliberate: it keeps the exclusion provable in a unit test (script an admin
// row alongside a member row and assert the admin one does not reach the
// response), which a server-side filter would hide behind the query builder.
//
// FOLLOW-UP: pushing this predicate into the `admin_*` RPCs as a SQL
// `join app_user au on au.id = <t>.user_id where not au.is_admin` (the shape
// ENG-314 already used for `admin_trials_by_month`) would be faster at scale.
// That is a stablepass-be change and is deliberately NOT done here.
import type { SupabaseClient } from "@supabase/supabase-js";

/** A row that carries the acting user — every engagement table has one. */
export type UserOwnedRow = { user_id: string | null };

/**
 * The set of `app_user.id` values that belong to operators.
 *
 * Read once per request and passed down, rather than re-queried per metric —
 * the analytics screen fans out into ~8 parallel reads and they must all agree
 * on the same exclusion set.
 */
export async function getAdminUserIds(sb: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await sb.from("app_user").select("id").eq("is_admin", true);
  // Fail loud. A silent empty set here would look exactly like "there are no
  // admins" and would quietly put staff activity back into every number — the
  // precise bug this module exists to prevent.
  if (error) throw new Error(`admin exclusion: could not load admin accounts: ${error.message}`);
  return new Set(((data ?? []) as { id: string }[]).map((r) => r.id));
}

/**
 * Drop every row produced by an operator.
 *
 * A row with a null/absent `user_id` is KEPT: it cannot be attributed to an
 * admin, and dropping it would silently under-count member activity.
 */
export function excludeAdminRows<T extends UserOwnedRow>(rows: T[], adminIds: Set<string>): T[] {
  return rows.filter((r) => r.user_id == null || !adminIds.has(r.user_id));
}

/**
 * Fetch member-only rows from an engagement table.
 *
 * THIS IS THE FUNCTION A NEW ANALYTICS ENDPOINT SHOULD CALL. Because the
 * exclusion happens inside it, an endpoint added later gets the guarantee by
 * construction instead of having to remember a filter — which is the whole
 * point of ENG-984.
 *
 * `columns` must include `user_id`, otherwise there is nothing to exclude on;
 * that is asserted rather than assumed, so a future caller cannot accidentally
 * opt out of the exclusion by trimming the select list.
 *
 * @param shape optional extra PostgREST filters (period bounds, a post id, ...)
 */
// Rows requested per batch. This is a REQUEST size, not a promise about the
// response — PostgREST clips any response at its own `db-max-rows` (1000 by
// default), so a batch can come back short while rows remain.
const PAGE_SIZE = 1000;
// Runaway guard only. Hitting it is an ERROR, not a stopping condition.
const MAX_BATCHES = 100;

/**
 * Fetch EVERY matching row, not just the first page.
 *
 * This paging is the whole reason the helper exists rather than a bare
 * `sb.from(t).select(...)`. An unpaged select is silently clipped at
 * `db-max-rows`, so `rows.length` freezes at 1000 — the same trap ENG-976 hit
 * on the waitlist header (see `app/(dash)/waitlist/data.ts`). For analytics
 * that would under-report every number without an error, which is a worse lie
 * than the operator contamination this module exists to remove.
 *
 * Termination is driven by the server's OWN exact count rather than by "the
 * batch came back short". A short batch is ambiguous — it means either "that
 * was the last of them" or "the server clipped this response" — and treating
 * the second as the first is exactly how a truncated aggregate ships green.
 * Asking for `count: "exact"` alongside the rows removes the ambiguity: we know
 * up front how many rows there are, so we can page until we have them all.
 */
async function fetchAllRows<T>(
  sb: SupabaseClient,
  table: string,
  columns: string,
  shape?: (q: ReturnType<SupabaseClient["from"]>) => unknown,
): Promise<T[]> {
  const all: T[] = [];
  let total: number | null = null;

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const base = sb.from(table).select(columns, { count: "exact" });
    const shaped = (shape ? shape(base as never) : base) as unknown as {
      range: (from: number, to: number) => PromiseLike<{
        data: unknown;
        error: { message: string } | null;
        count: number | null;
      }>;
    };

    // Advance by rows actually RECEIVED, never by the requested batch size.
    const from = all.length;
    const { data, error, count } = await shaped.range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table} query: ${error.message}`);
    if (count != null) total = count;

    const rows = (data ?? []) as T[];
    all.push(...rows);

    if (rows.length === 0) return all;
    if (total != null && all.length >= total) return all;
    // No count came back (the unit-test fake doesn't model one). There is
    // nothing to page against, so take the single batch rather than loop.
    if (total == null) return all;
  }

  throw new Error(
    `${table} query: still returning rows after ${MAX_BATCHES} batches of ${PAGE_SIZE} — refusing to loop further.`,
  );
}

export async function memberRows<T extends UserOwnedRow>(
  sb: SupabaseClient,
  table: string,
  columns: string,
  shape?: (q: ReturnType<SupabaseClient["from"]>) => unknown,
  adminIds?: Set<string>,
): Promise<T[]> {
  if (!/\buser_id\b/.test(columns)) {
    throw new Error(
      `admin exclusion: select on "${table}" must include user_id (got "${columns}") — ` +
        "without it admin activity cannot be excluded.",
    );
  }

  const ids = adminIds ?? (await getAdminUserIds(sb));

  const rows = await fetchAllRows<T>(sb, table, columns, shape);

  // The `columns` check above is textual, and a select like `user:user_id(...)`
  // would satisfy the regex while returning no TOP-LEVEL `user_id` — every row
  // would then look unattributable and be kept, silently excluding nobody. Fail
  // loudly on the actual data instead of trusting the string.
  if (rows.length > 0 && !("user_id" in (rows[0] as object))) {
    throw new Error(
      `admin exclusion: rows from "${table}" carry no top-level user_id (select was "${columns}") — ` +
        "refusing to return unfiltered analytics data.",
    );
  }

  return excludeAdminRows(rows, ids);
}

/** Member-only row count for an engagement table (saves, reach, tiles). */
export async function countMemberRows(
  sb: SupabaseClient,
  table: string,
  shape?: (q: ReturnType<SupabaseClient["from"]>) => unknown,
  adminIds?: Set<string>,
): Promise<number> {
  const rows = await memberRows(sb, table, "user_id", shape, adminIds);
  return rows.length;
}
