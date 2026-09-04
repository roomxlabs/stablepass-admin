import type { SupabaseClient } from "@supabase/supabase-js";

// Server-side data access for the admin Waitlist list. Kept out of the page
// component so it can be unit-tested against the Supabase fake, the same way
// listTrainers is.
//
// READ PATH. `public.waitlist` is admin-only: its RLS grants SELECT through
// `waitlist_select_admin`, which calls `is_admin(auth.uid())` and therefore
// requires an AAL2 session. This module reads it with the caller's own client,
// so the policy — not this code — is what keeps the addresses private, and it
// holds even if a caller forgets a gate. Callers gate anyway: the page calls
// requireAdminPage() itself (as well as sitting under the (dash) layout's
// gate), and both BFF routes call requireAdmin().
//
// ENG-723 shipped the table with "no admin UI reads it, deliberately", because
// launch invites were to be exported by hand from the Supabase dashboard. This
// page is the sanctioned reversal of that (Naufal, 2 Sep): the same read, given
// a screen, so nobody has to run SQL to see who has signed up.

export type WaitlistRow = {
  id: string;
  email: string;
  /** Free-text origin, defaulted to 'marketing' by the table. */
  source: string | null;
  joinedAt: string | null;
};

export type WaitlistList = {
  rows: WaitlistRow[];
  /** Total signups, ignoring any active search — the headline number. */
  total: number;
  /** Exact count of rows the active filter matches (unpaginated). */
  matching: number;
  offset: number;
  limit: number;
};

type WaitlistDbRow = {
  id: string;
  email: string | null;
  source: string | null;
  created_at: string | null;
};

/**
 * PostgREST treats these as operators inside `or(...)`/`ilike` patterns, so a
 * raw query string could otherwise change the shape of the filter rather than
 * be matched literally. Mirrors the sanitising the trainers list does.
 */
export function sanitize(term: string): string {
  return term.replace(/[,()*%\\]/g, " ").trim();
}

// Page size used by the admin Waitlist list when no `limit` is given.
export const WAITLIST_PAGE_SIZE = 25;

export type WaitlistListParams = { q?: string; offset?: number; limit?: number };

function mapRows(rows: WaitlistDbRow[]): WaitlistRow[] {
  return rows
    .map((r) => ({
      id: r.id,
      email: (r.email ?? "").trim(),
      source: r.source?.trim() || null,
      joinedAt: r.created_at ?? null,
    }))
    // A row with no address is unusable for a launch invite and would render as
    // an empty line; drop it rather than show a blank row.
    .filter((r) => r.email.length > 0);
}

export async function listWaitlist(
  sb: SupabaseClient,
  params: WaitlistListParams = {},
): Promise<WaitlistList> {
  const text = params.q ? sanitize(params.q) : "";
  const offset = params.offset ?? 0;
  const limit = params.limit ?? WAITLIST_PAGE_SIZE;

  // Newest first: the useful reading of a signup list is "who just joined".
  // Newest first, with `id` as a TIEBREAKER. Ordering on `created_at` alone is
  // not a total order: two signups sharing a timestamp (a bulk import, or two
  // in the same clock tick) have no guaranteed relative order across separate
  // LIMIT/OFFSET queries, so the same row could appear on both page 1 and
  // page 2 — or on neither. The tiebreaker makes paging deterministic.
  let query = sb
    .from("waitlist")
    .select("id,email,source,created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  if (text) query = query.ilike("email", `%${text}%`);

  // The headline count is deliberately UNFILTERED, so searching narrows the
  // list without appearing to shrink the waitlist itself.
  //
  // It is counted with `head: true` + `count: "exact"` — a COUNT on the server,
  // fetching zero rows. Reading `select("id").length` instead (as this did
  // before ENG-976) is wrong twice over: it is itself subject to PostgREST's
  // `db-max-rows` cap, so past ~1000 signups the header would freeze at the cap
  // and stop climbing — the exact thing this number exists to show — and it
  // pulls every row id on every render, which defeats paginating at all.
  const [{ data: rows, count }, { count: totalCount }] = await Promise.all([
    query.range(offset, offset + limit - 1),
    sb.from("waitlist").select("id", { count: "exact", head: true }),
  ]);

  const mapped = mapRows((rows ?? []) as WaitlistDbRow[]);

  return {
    rows: mapped,
    total: totalCount ?? mapped.length,
    matching: count ?? mapped.length,
    offset,
    limit,
  };
}

// Rows requested per batch in fetchAllWaitlist's paging loop. This is a REQUEST
// size, not a promise about the response: PostgREST caps responses at its own
// `db-max-rows` (1000 by default), so a batch may legitimately come back short
// while more rows remain. The loop below must never infer "done" from a short
// batch for exactly that reason.
const EXPORT_BATCH_SIZE = 1000;
// Runaway guard only: stops a misbehaving backend (one that keeps returning
// rows forever) from looping without end. Hitting it is an ERROR, not a
// stopping condition — see the throw below.
const EXPORT_MAX_BATCHES = 100;

/**
 * The FULL waitlist (or the full filtered match), ignoring any page window —
 * used to build the CSV export so it is not silently truncated to whatever
 * page the admin happened to be viewing.
 */
export async function fetchAllWaitlist(
  sb: SupabaseClient,
  params: { q?: string } = {},
): Promise<WaitlistRow[]> {
  const text = params.q ? sanitize(params.q) : "";
  const all: WaitlistDbRow[] = [];
  let from = 0;
  let done = false;

  for (let batch = 0; batch < EXPORT_MAX_BATCHES; batch++) {
    let query = sb
      .from("waitlist")
      .select("id,email,source,created_at")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    if (text) query = query.ilike("email", `%${text}%`);
    const { data } = await query.range(from, from + EXPORT_BATCH_SIZE - 1);
    const rows = (data ?? []) as WaitlistDbRow[];
    all.push(...rows);

    // Terminate on an EMPTY batch, and advance by the rows actually RECEIVED —
    // never by the requested batch size, and never on "the batch came back
    // short". A short batch is ambiguous: it means either "that was the last of
    // them" or "the server clipped this response at db-max-rows". Treating the
    // second as the first silently exports a fraction of the list with a 200
    // and no warning, which is the worst possible failure for the one job this
    // endpoint has (seeding the launch newsletter).
    if (rows.length === 0) {
      done = true;
      break;
    }
    from += rows.length;
  }

  // Ran out of batches with rows still coming. Refusing is the only safe answer:
  // a short CSV is indistinguishable from a complete one once it is downloaded,
  // so a loud failure the admin can retry beats a quiet half-list they cannot
  // detect.
  if (!done) {
    throw new Error(
      `Waitlist export exceeded ${EXPORT_MAX_BATCHES} batches (${all.length} rows read); refusing to return a possibly-truncated CSV.`,
    );
  }

  return mapRows(all);
}

// Fields that Excel/Sheets would interpret as the START of a formula if
// pasted/opened raw — prefixed with a leading `'` (CSV-injection defence).
//
// Leading whitespace is part of the pattern ON PURPOSE. A spreadsheet still
// evaluates "\t=1+1", and TAB / VTAB / FF / NBSP / BOM all sail past a bare
// `^[=+\-@]`. Those payloads are currently also defused by mapRows' `.trim()`,
// but that trim was written for cosmetic reasons in a different function — so
// relying on it means a later "harmless" cleanup that drops the trim silently
// re-opens formula execution, breaking no test. Anchor the defence here, where
// it is the stated job.
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
 * RFC4180-ish CSV for the waitlist export: `email,source,joined_at` header,
 * `\r\n` line endings, a trailing newline. Escapes quotes/commas/newlines and
 * neutralises leading `=`/`+`/`-`/`@` so opening the file in Excel can't
 * execute a formula from an attacker-supplied email/source.
 */
export function toCsv(rows: WaitlistRow[]): string {
  const lines = ["email,source,joined_at"];
  for (const r of rows) {
    lines.push(
      [csvField(r.email), csvField(r.source ?? ""), csvField(r.joinedAt ?? "")].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

/**
 * The addresses as one comma-separated string, for pasting into the BCC field
 * of a launch email. This is the job the page exists to serve, so it is derived
 * here (and unit-tested) rather than assembled in the component.
 */
export function emailsFor(rows: WaitlistRow[]): string {
  return rows.map((r) => r.email).join(", ");
}
