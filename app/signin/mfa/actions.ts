"use server";

import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { logAdminAuthEvent } from "@/lib/audit";

export type MfaState = { error?: string };

// BFF sign-in, STEP 2 of 2 (ENG-370): verify the TOTP code against the factor
// enrolled on the AAL1 session that step 1 minted. Success upgrades the same
// cookie session to AAL2, which is what every gate — and, after ENG-368,
// Postgres's own is_admin() — actually requires.
export async function verifyMfa(_prev: MfaState, formData: FormData): Promise<MfaState> {
  const code = String(formData.get("code") ?? "").trim();
  if (!/^\d{6}$/.test(code)) return { error: "Enter the 6-digit code from your app." };

  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/signin");

  const { data: factors } = await sb.auth.mfa.listFactors();
  const factorId = factors?.totp?.[0]?.id;
  if (!factorId) redirect("/signin/mfa-setup");

  const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code });

  if (error) {
    // ORDER IS LOAD-BEARING: log BEFORE signOut(). log_admin_auth_event is
    // authenticated-only and carries an in-body guard — called once we are anon
    // it writes zero rows and still returns 204, so logging after the sign-out
    // would silently lose every failed-challenge row.
    await logAdminAuthEvent("mfa_fail", user.email ?? "", sb);
    // Drop the half-authenticated AAL1 session rather than leaving it alive.
    await sb.auth.signOut();
    // Generic on purpose: the screen must never confirm the password was valid.
    redirect("/signin?error=mfa");
  }

  await logAdminAuthEvent("mfa_ok", user.email ?? "", sb);
  redirect("/");
}
