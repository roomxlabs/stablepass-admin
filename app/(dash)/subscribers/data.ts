import type { SupabaseClient } from "@supabase/supabase-js";

// Server-side data access for the admin Subscribers list. Kept out of the page
// component so it can be unit-tested against the Supabase fake, the same way
// listWaitlist / getSubscribers are.
//
// READ PATH. `public.subscription` carries `user_id` (an FK into `app_user`),
// which the existing GET /api/admin/subscribers aggregate endpoint deliberately
// never returns (guardrail §4: aggregates only, no member PII). This module is
// the sanctioned per-row read behind that same route's opt-in `view=list` mode
// (ENG-982) — callers still go through requireAdmin() first, same as every
// other app/api/admin/* route.
//
// STAFF EXCLUSION (ENG-315): every signup gets a trial subscription, operators
// included, since an admin is an app_user promoted to is_admin after signup.
// Any subscriber list/export must exclude staff rows the same way
// lib/dashboard/queries.ts's getSubscribers/isStaff do — this module mirrors
// that semantic rather than importing it, since dashboard/queries.ts is a
// separate surface this ticket does not touch.

export type SubscriberStatus = "trial" | "active" | "lapsed" | "canceled";

export const SUBSCRIBER_STATUSES: SubscriberStatus[] = ["trial", "active", "lapsed", "canceled"];

export type SubscriberRow = {
  id: string;
  name: string | null;
  email: string;
  status: string;
  startedAt: string | null;
  currentPeriodEnd: string | null;
  // Derived, NOT a real column — see the comment on canceledAtFrom below.
  canceledAt: string | null;
  tenureMonths: number;
};

export type SubscribersList = {
  rows: SubscriberRow[];
  /** ALL non-staff subscribers, ignoring any active filter — the headline number. */
  total: number;
  /** Count of rows the active filters match, before the page window. */
  matching: number;
  offset: number;
  limit: number;
};

export type SubscriberFilters = {
  status?: string;
  minMonths?: number;
  maxMonths?: number;
  q?: string;
};

// Page size used by the admin Subscribers list when no `limit` is given.
export const SUBSCRIBERS_PAGE_SIZE = 25;

type SubscriptionUserEmbed = { name?: string | null; email?: string | null; is_admin?: boolean | null };

type SubscriptionDbRow = {
  id: string;
  status: string | null;
  created_at: string | null;
  updated_at: string | null;
  current_period_end: string | null;
  user: SubscriptionUserEmbed | SubscriptionUserEmbed[] | null;
};

// PostgREST returns a to-one embed as an object OR a 1-element array,
// depending on how the FK is declared/queried. Mirrors `one()` in
// lib/dashboard/queries.ts.
function one<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/**
 * Whole COMPLETED months between `from` and `now`. Returns 0 for a null,
 * unparseable, or FUTURE `from` (a subscription that started "in the future"
 * relative to `now` has no completed tenure to report).
 *
 * TIMEZONE: the calendar accessors below are LOCAL to wherever this runs (UTC
 * on Vercel), while the Subscribed column is rendered in the BROWSER's zone by
 * <LocalTime>. So tenure can tick over a few hours either side of the date an
 * operator sees. Both the number shown and the cohort filtered come from THIS
 * function, so the two can never disagree with each other — deliberately left
 * as-is rather than half-converted to UTC, which would only move the seam.
 */
export function tenureMonths(from: string | null, now: Date = new Date()): number {
  if (!from) return 0;
  const d = new Date(from);
  if (Number.isNaN(d.getTime())) return 0;
  if (d.getTime() > now.getTime()) return 0;

  let months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());

  // A completed month needs `now`'s day-of-month to have reached `d`'s — but
  // CLAMPED to the length of `now`'s month, because a short month can never
  // reach a day-of-month that does not exist in it.
  //
  // Without the clamp, someone who subscribed on the 31st is under-counted for
  // the last days of every short month: 31 Jan → 28 Feb read 0 months, and
  // 29 Feb 2024 → 28 Feb 2025 read 11 — putting a subscriber with a full year
  // into the "6–11 months" cohort. That is a wrong answer to the exact question
  // this screen exists to answer, so the anniversary is treated as having
  // landed on the last day of a month too short to contain it.
  const lastDayOfNowMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const anniversaryDay = Math.min(d.getDate(), lastDayOfNowMonth);
  if (now.getDate() < anniversaryDay) months -= 1;

  return Math.max(0, months);
}

/**
 * `subscription.updated_at` is the closest column we have to a cancellation
 * date — the schema (docs/specs/database.sql) has NO `canceled_at` column.
 * This is a KNOWN APPROXIMATION, disclosed on the PR: `updated_at` moves on
 * any write to the row (e.g. a `current_period_end` refresh from Stripe), not
 * only a cancellation, so this can read "later" than the true cancel date. A
 * real `canceled_at` column would be a backend ticket; until then, treat this
 * field as "last touched while canceled", not an audit-grade timestamp.
 */
function canceledAtFrom(status: string | null, updatedAt: string | null): string | null {
  return status === "canceled" ? updatedAt : null;
}

function mapRows(rows: SubscriptionDbRow[], now: Date): SubscriberRow[] {
  return rows
    // Staff exclusion (ENG-315): an operator's own trial subscription is never
    // a "subscriber" for this list/export.
    .filter((r) => !one(r.user)?.is_admin)
    .map((r) => {
      const user = one(r.user);
      return {
        id: r.id,
        name: user?.name?.trim() || null,
        email: (user?.email ?? "").trim(),
        status: r.status ?? "",
        startedAt: r.created_at ?? null,
        currentPeriodEnd: r.current_period_end ?? null,
        canceledAt: canceledAtFrom(r.status, r.updated_at),
        tenureMonths: tenureMonths(r.created_at, now),
      };
    })
    // A row whose user embed could not be read (or whose address is blank)
    // would render as a nameless, unreachable line; drop it rather than show
    // one, mirroring the waitlist's blank-email drop.
    .filter((r) => r.email.length > 0);
}

// Rows requested per batch in fetchAllSubscribers's paging loop. This is a
// REQUEST size, not a promise about the response: PostgREST caps responses at
// its own `db-max-rows` (1000 by default), so a batch may legitimately come
// back short while more rows remain. The loop below must never infer "done"
// from a short batch for exactly that reason.
const EXPORT_BATCH_SIZE = 1000;
// Runaway guard only: stops a misbehaving backend (one that keeps returning
// rows forever) from looping without end. Hitting it is an ERROR, not a
// stopping condition — see the throw below.
const EXPORT_MAX_BATCHES = 100;

/**
 * Every non-staff subscriber, batched, mapped, and sorted newest-first —
 * ignores any page window. Used both by `listSubscribers` (which pages the
 * result in JS, since the status/tenure/q filters are applied in JS too — see
 * `applyFilters`) and by the CSV export.
 */
export async function fetchAllSubscribers(
  sb: SupabaseClient,
  now: Date = new Date(),
): Promise<SubscriberRow[]> {
  const all: SubscriptionDbRow[] = [];
  let from = 0;
  let done = false;

  for (let batch = 0; batch < EXPORT_MAX_BATCHES; batch++) {
    const { data, error } = await sb
      .from("subscription")
      .select("id,status,created_at,updated_at,current_period_end,user:user_id(name,email,is_admin)")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + EXPORT_BATCH_SIZE - 1);

    // THROW on a query error — never treat it as "no more rows". supabase-js
    // does not throw; it returns `{ data: null, error }`. Swallowing that makes
    // `data ?? []` an EMPTY batch, which the loop below reads as its normal
    // termination signal — so a statement timeout mid-export returns the rows
    // read so far, with a 200 and no warning, and a FIRST-batch error returns
    // zero rows, which the page renders as the reassuring "No subscribers yet"
    // empty state on a perfectly healthy database. Both are the exact silent
    // truncation the batching comment below refuses to allow; the runaway
    // guard alone does not cover them.
    if (error) {
      throw new Error(
        `Subscribers fetch failed at offset ${from}: ${error.message ?? String(error)}`,
      );
    }

    const rows = (data ?? []) as SubscriptionDbRow[];
    all.push(...rows);

    // Terminate on an EMPTY batch, and advance by the rows actually RECEIVED —
    // never by the requested batch size, and never on "the batch came back
    // short". A short batch is ambiguous: it means either "that was the last
    // of them" or "the server clipped this response at db-max-rows". Treating
    // the second as the first silently truncates the list/export with a 200
    // and no warning, which is the worst possible failure for the one job
    // this function has.
    if (rows.length === 0) {
      done = true;
      break;
    }
    from += rows.length;
  }

  // Ran out of batches with rows still coming. Refusing is the only safe
  // answer: a short CSV (or list) is indistinguishable from a complete one
  // once returned, so a loud failure the caller can retry beats a quiet
  // half-list they cannot detect.
  if (!done) {
    throw new Error(
      `Subscribers fetch exceeded ${EXPORT_MAX_BATCHES} batches (${all.length} rows read); refusing to return a possibly-truncated list.`,
    );
  }

  return mapRows(all, now);
}

/** Apply status / tenure / q filters in JS. Pure — unit-tested directly. */
export function applyFilters(rows: SubscriberRow[], f: SubscriberFilters): SubscriberRow[] {
  let out = rows;

  if (f.status && f.status !== "all") {
    const status = f.status;
    out = out.filter((r) => r.status === status);
  }
  if (typeof f.minMonths === "number" && !Number.isNaN(f.minMonths)) {
    const min = f.minMonths;
    out = out.filter((r) => r.tenureMonths >= min);
  }
  if (typeof f.maxMonths === "number" && !Number.isNaN(f.maxMonths)) {
    const max = f.maxMonths;
    out = out.filter((r) => r.tenureMonths <= max);
  }
  if (f.q) {
    const needle = f.q.toLowerCase();
    out = out.filter(
      (r) => (r.name ?? "").toLowerCase().includes(needle) || r.email.toLowerCase().includes(needle),
    );
  }

  return out;
}

/** `fetchAllSubscribers` -> `applyFilters` -> page window. */
export async function listSubscribers(
  sb: SupabaseClient,
  params: SubscriberFilters & { offset?: number; limit?: number } = {},
  now: Date = new Date(),
): Promise<SubscribersList> {
  const offset = Math.max(0, params.offset ?? 0);
  const limit = params.limit ?? SUBSCRIBERS_PAGE_SIZE;

  const all = await fetchAllSubscribers(sb, now);
  // The headline total is deliberately UNFILTERED, so narrowing the list
  // doesn't appear to shrink the subscriber base itself — same reasoning as
  // listWaitlist's total.
  const total = all.length;
  const filtered = applyFilters(all, params);
  const matching = filtered.length;
  const rows = filtered.slice(offset, offset + limit);

  return { rows, total, matching, offset, limit };
}

// Fields that Excel/Sheets would interpret as the START of a formula if
// pasted/opened raw — prefixed with a leading `'` (CSV-injection defence).
// Leading whitespace is part of the pattern on purpose — see the identical
// comment in app/(dash)/waitlist/data.ts, which this defence is copied from.
const FORMULA_PREFIX = /^[\s\u00A0\uFEFF]*[=+\-@]/;
// Anything requiring RFC4180 quoting.
const NEEDS_QUOTING = /["\r\n,]/;

function csvField(value: string): string {
  let v = value;
  if (FORMULA_PREFIX.test(v)) v = `'${v}`;
  if (NEEDS_QUOTING.test(v)) v = `"${v.replace(/"/g, '""')}"`;
  return v;
}

/**
 * RFC4180-ish CSV for the subscribers export:
 * `name,email,status,started_at,tenure_months,current_period_end,canceled_at`
 * header, `\r\n` line endings, a trailing newline. Escapes quotes/commas/
 * newlines and neutralises a leading `=`/`+`/`-`/`@` so opening the file in
 * Excel can't execute a formula from an attacker-supplied name.
 */
export function toCsv(rows: SubscriberRow[]): string {
  const lines = ["name,email,status,started_at,tenure_months,current_period_end,canceled_at"];
  for (const r of rows) {
    lines.push(
      [
        csvField(r.name ?? ""),
        csvField(r.email),
        csvField(r.status),
        csvField(r.startedAt ?? ""),
        csvField(String(r.tenureMonths)),
        csvField(r.currentPeriodEnd ?? ""),
        csvField(r.canceledAt ?? ""),
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
