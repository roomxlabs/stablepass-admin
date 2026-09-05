import type { SupabaseClient } from "@supabase/supabase-js";

// Server-side data access for the admin Waitlist list. Kept out of the page
// component so it can be unit-tested against the Supabase fake, the same way
// listTrainers is.
//
// READ PATH. `public.waitlist` is admin-only: its RLS grants SELECT through
// `waitlist_select_admin`, which calls `is_admin(auth.uid())` and therefore
// requires an AAL2 session. This module reads it with the caller's own client,
// so the policy — not this code — is what keeps the addresses private. The
// (dash) layout's requireAdminPage() gate means a non-admin never reaches the
// page either.
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

export type WaitlistListParams = { q?: string };

export async function listWaitlist(
  sb: SupabaseClient,
  params: WaitlistListParams = {},
): Promise<WaitlistList> {
  const text = params.q ? sanitize(params.q) : "";

  // Newest first: the useful reading of a signup list is "who just joined".
  let query = sb
    .from("waitlist")
    .select("id,email,source,created_at")
    .order("created_at", { ascending: false });

  if (text) query = query.ilike("email", `%${text}%`);

  // The headline count is deliberately UNFILTERED, so searching narrows the
  // list without appearing to shrink the waitlist itself.
  const [{ data: rows }, { data: all }] = await Promise.all([
    query,
    sb.from("waitlist").select("id"),
  ]);

  const mapped: WaitlistRow[] = ((rows ?? []) as WaitlistDbRow[])
    .map((r) => ({
      id: r.id,
      email: (r.email ?? "").trim(),
      source: r.source?.trim() || null,
      joinedAt: r.created_at ?? null,
    }))
    // A row with no address is unusable for a launch invite and would render as
    // an empty line; drop it rather than show a blank row.
    .filter((r) => r.email.length > 0);

  return { rows: mapped, total: (all ?? []).length };
}

/**
 * The addresses as one comma-separated string, for pasting into the BCC field
 * of a launch email. This is the job the page exists to serve, so it is derived
 * here (and unit-tested) rather than assembled in the component.
 */
export function emailsFor(rows: WaitlistRow[]): string {
  return rows.map((r) => r.email).join(", ");
}
