"use server";

import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { logAdminAuthEvent, type AdminAuthEvent } from "@/lib/audit";

export type MfaSetupState = { error?: string };

// `lib/audit.ts`'s own header reserves `mfa_enrolled` for this screen ("Events
// this app writes. `mfa_enrolled` is A2's") and the RPC's check constraint
// accepts it, but the exported AdminAuthEvent union it ships omits the literal.
// That file is A1's (ENG-370) and on this ticket's do-NOT-touch list, so the
// gap is bridged here at the call site instead of by editing it. Flagged on the
// PR so A1's union can absorb it later.
const MFA_ENROLLED = "mfa_enrolled" as AdminAuthEvent;

// Verify the FIRST code for a freshly enrolled factor (ENG-371). This is what
// flips the factor to `verified` and upgrades the same cookie session to AAL2 —
// after ENG-368 that is what Postgres's own is_admin() requires, so the
// dashboard only reads rows once this has run.
export async function verifyEnrolment(
  _prev: MfaSetupState,
  formData: FormData,
): Promise<MfaSetupState> {
  const code = String(formData.get("code") ?? "").trim();
  const factorId = String(formData.get("factorId") ?? "").trim();

  if (!/^\d{6}$/.test(code)) return { error: "Enter the 6-digit code from your app." };
  if (!factorId) return { error: "That enrolment expired. Reload the page for a fresh QR code." };

  const sb = await supabaseServer();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/signin");

  // Defence in depth: factorId arrives from the form, so confirm it is one of
  // THIS session's own factors before spending it. GoTrue scopes the verify to
  // the caller anyway; this just refuses to forward an id the signed-in admin
  // does not own. Skipped when the read itself failed, so a transient blip
  // cannot lock someone out of finishing enrolment.
  const { data: factors, error: listError } = await sb.auth.mfa.listFactors();
  if (!listError && factors && !(factors.all ?? []).some((f) => f.id === factorId)) {
    return { error: "That enrolment expired. Reload the page for a fresh QR code." };
  }

  const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code });

  if (error) {
    // DELIBERATELY NO signOut() HERE — unlike the challenge screen there is no
    // verified factor to fall back to, so dropping the session would bounce the
    // admin to /signin, straight back through the gate, and back to this screen
    // with nothing enrolled: a loop they cannot exit. The factor stays
    // unverified and they simply retry with the next code from their app.
    return { error: "That code didn't match. Check your app and try again." };
  }

  // A session exists (AAL1, now AAL2), so the authenticated RPC is the right
  // one — it attributes the row from auth.uid().
  await logAdminAuthEvent(MFA_ENROLLED, user.email ?? "", sb);
  redirect("/");
}
