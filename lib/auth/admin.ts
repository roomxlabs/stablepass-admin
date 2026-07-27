import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { fail, UNAUTH } from "@/lib/api/envelope";
import type { SupabaseClient, User } from "@supabase/supabase-js";

// Assurance level of the current session, read via Supabase's own MFA API
// rather than by hand-decoding the JWT (ENG-370).
//
// Fails CLOSED: any throw/error is reported as "not aal2", because after
// ENG-368 `is_admin()` in Postgres requires aal2 too — an AAL1 admin's reads
// return 0 rows WITH NO ERROR, so a gate that guessed "probably fine" would
// render a convincingly empty dashboard instead of redirecting.
//
// `nextLevel === 'aal2'` means a VERIFIED factor exists (auth-js derives it
// from user.factors), which is how we tell "needs to challenge" from "needs to
// enrol" without a second round trip.
//
// `hasFactor` is deliberately TRI-STATE. "We could not read the assurance
// level" is not the same as "this admin has enrolled nothing": conflating them
// sends an already-enrolled admin to forced re-enrolment on a transient blip.
// null = unknown, and the caller routes it to the challenge screen, which
// re-derives the answer safely for itself.
async function assurance(
  sb: SupabaseClient,
): Promise<{ isAal2: boolean; hasFactor: boolean | null }> {
  try {
    const { data, error } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    // auth-js returns `{data:null, error}` on a session error (it does not
    // throw), so this branch — not the catch — is the common failure path.
    if (error || !data) return { isAal2: false, hasFactor: null };
    return { isAal2: data.currentLevel === "aal2", hasFactor: data.nextLevel === "aal2" };
  } catch {
    return { isAal2: false, hasFactor: null };
  }
}

// Resolve the caller and require is_admin. Returns { sb } on success, or a Response to return.
// Used by every app/api/admin/* route handler (401 no session, 403 non-admin).
//
// ENG-370 adds a THIRD condition; it does not relax the first two. An admin
// whose session is only AAL1 gets 403 `mfa_required` — never 401 (they do have
// a session) and never 200 with silently-empty data.
export async function requireAdmin(): Promise<{ sb: SupabaseClient } | { res: Response }> {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { res: UNAUTH() };
  const { data } = await sb.from("app_user").select("is_admin").eq("id", user.id).single();
  if (!data?.is_admin) return { res: fail("forbidden", "Admin only.", 403) };
  const { isAal2 } = await assurance(sb);
  if (!isAal2) return { res: fail("mfa_required", "Two-factor authentication required.", 403) };
  return { sb };
}

// Server-Component / layout variant of the gate. A React tree can't return a
// Response, so the not-authorized branches redirect instead of 401/403-ing:
//   - no session   -> /signin
//   - not is_admin -> /signin?error=forbidden  (the "403 / redirect" the ticket allows)
//   - admin @ aal1 -> /signin/mfa  (or /signin/mfa-setup when no factor is enrolled)
// On success returns the caller's RLS client + the authenticated user so the
// (dash) shell can render the signed-in identity. Gates every (dash) page.
//
// All three checks run before the caller is handed `sb`, so no page-level table
// read can happen on a session that would silently read 0 rows under aal2 RLS.
export async function requireAdminPage(): Promise<{ sb: SupabaseClient; user: User }> {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/signin");
  const { data } = await sb.from("app_user").select("is_admin").eq("id", user.id).single();
  if (!data?.is_admin) redirect("/signin?error=forbidden");
  const { isAal2, hasFactor } = await assurance(sb);
  // Only send them to ENROL on positive knowledge that nothing is enrolled;
  // unknown (null) goes to the challenge screen, which checks for itself.
  if (!isAal2) redirect(hasFactor === false ? "/signin/mfa-setup" : "/signin/mfa");
  return { sb, user };
}
