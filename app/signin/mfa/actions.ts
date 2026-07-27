"use server";

import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { logAdminAuthEvent } from "@/lib/audit";

export type MfaState = { error?: string; attempts?: number };

// Wrong codes tolerated before we fall back to dropping the session and
// restarting at the password step.
//
// A mistyped digit is the common case, so bouncing to /signin on the FIRST miss
// made an admin re-enter email + password to fix a typo. We keep the AAL1
// session and let them retry in place instead.
//
// This does not disclose anything new: /signin/mfa already renders "Signed in
// as {email}", so reaching this screen at all has already confirmed the
// password was valid. The only property the old bounce protected was a limit on
// TOTP guesses per password entry — that is what the cap below preserves.
//
// The counter round-trips through the client via useActionState, so a
// determined caller can reset it. It is a usability guard, not the security
// boundary; GoTrue rate-limits MFA verification server-side, and every failure
// is written to admin_auth_event regardless.
const MAX_ATTEMPTS = 5;

// BFF sign-in, STEP 2 of 2 (ENG-370): verify the TOTP code against the factor
// enrolled on the AAL1 session that step 1 minted. Success upgrades the same
// cookie session to AAL2, which is what every gate — and, after ENG-368,
// Postgres's own is_admin() — actually requires.
export async function verifyMfa(prev: MfaState, formData: FormData): Promise<MfaState> {
  // Malformed input never reaches challengeAndVerify, so it does not burn an
  // attempt — otherwise a stray keystroke would cost the admin a retry.
  const attempts = prev?.attempts ?? 0;
  const code = String(formData.get("code") ?? "").trim();
  if (!/^\d{6}$/.test(code)) return { error: "Enter the 6-digit code from your app.", attempts };

  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/signin");

  const { data: factors } = await sb.auth.mfa.listFactors();
  const factorId = factors?.totp?.[0]?.id;
  if (!factorId) redirect("/signin/mfa-setup");

  const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code });

  if (error) {
    // ORDER IS LOAD-BEARING: log BEFORE any signOut(). log_admin_auth_event is
    // authenticated-only and carries an in-body guard — called once we are anon
    // it writes zero rows and still returns 204, so logging after the sign-out
    // would silently lose every failed-challenge row. Every miss is logged,
    // including the ones we let the admin retry.
    await logAdminAuthEvent("mfa_fail", user.email ?? "", sb);

    const used = attempts + 1;
    const left = MAX_ATTEMPTS - used;

    if (left <= 0) {
      // Out of retries: the original behaviour. Drop the half-authenticated
      // AAL1 session rather than leaving it alive, and start over generically.
      await sb.auth.signOut();
      redirect("/signin?error=mfa");
    }

    // Keep the AAL1 session and stay on this screen so a mistyped code costs a
    // retry, not the whole sign-in.
    return {
      error: `That code didn't match. ${left} ${left === 1 ? "attempt" : "attempts"} left.`,
      attempts: used,
    };
  }

  await logAdminAuthEvent("mfa_ok", user.email ?? "", sb);
  redirect("/");
}
