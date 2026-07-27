"use server";

import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { logAdminAuthEvent, logAdminSignInFail } from "@/lib/audit";

export type SignInState = { error?: string };

// BFF sign-in, STEP 1 of 2 (ENG-370): credentials go to the server, Supabase
// mints the AAL1 session, and @supabase/ssr writes it to httpOnly cookies
// (never exposed to browser JS). Only an app_user with is_admin=true may in;
// anyone else is signed straight back out.
//
// A password alone no longer reaches the dashboard. Supabase must complete
// password auth before a TOTP code can be verified at all, so the second factor
// is a second screen: /signin/mfa to challenge an enrolled factor, or
// /signin/mfa-setup (A2) to enrol one. "/" is only reachable at AAL2.
export async function signIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };

  const sb = await supabaseServer();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    // log_admin_signin_fail, NOT log_admin_auth_event: the password just failed,
    // so there is no session and we are `anon`. The general RPC is
    // authenticated-only and would write zero rows while still reporting
    // success — losing exactly the forensic signal the audit table exists for.
    await logAdminSignInFail(email, sb);
    return { error: "Wrong email or password." };
  }

  const { data: profile } = await sb
    .from("app_user")
    .select("is_admin")
    .eq("id", data.user.id)
    .single();
  if (!profile?.is_admin) {
    // A VALID password on a non-staff account, aimed at the admin console, is a
    // forensic signal worth keeping. There is a session here, so the general
    // RPC is correct — and, as with mfa_fail, it must be called BEFORE signOut()
    // or the in-body guard drops the row while still returning 204.
    await logAdminAuthEvent("signin_fail", email, sb);
    // Not staff — don't leave a live session lying around.
    await sb.auth.signOut();
    return { error: "That account isn't an admin." };
  }

  // From here on there IS a session, so the general RPC is the right one.
  await logAdminAuthEvent("signin_ok", email, sb);

  // listFactors()'s `totp` bucket holds VERIFIED factors only (auth-js filters
  // on status), so a non-empty bucket means "can be challenged right now".
  const { data: factors } = await sb.auth.mfa.listFactors();
  const hasVerifiedTotp = (factors?.totp?.length ?? 0) > 0;

  // NOTE: single-device enforcement (revoke the account's other sessions on a
  // fresh sign-in) is owned by the backend session layer; the gate here only
  // asserts is_admin + aal2. See stablepass-admin/.rx/guardrails.md.
  redirect(hasVerifiedTotp ? "/signin/mfa" : "/signin/mfa-setup");
}

// Clear the session and return to the sign-in screen.
export async function signOut(): Promise<void> {
  const sb = await supabaseServer();
  await sb.auth.signOut();
  redirect("/signin");
}
