import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import MfaChallengeForm from "./MfaChallengeForm";

export const metadata: Metadata = {
  title: "Two-factor · stablepass admin",
};

// Step 2 of sign-in. Reuses screens/01-signin.html's .admin-signin /
// .admin-signin-card shell exactly — same lockup, ADMIN badge, input and button
// classes — with the mockup's Authenticator-code field on its own card.
export default async function MfaPage() {
  const sb = await supabaseServer();

  // No session at all: nothing to challenge.
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/signin");

  // Already upgraded (e.g. a second tab finished the challenge): go on through.
  const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel === "aal2") redirect("/");

  // Nothing enrolled yet — A2's forced-enrolment screen owns that path. Only
  // redirect on POSITIVE knowledge that there is no verified factor, so a
  // transient listFactors failure keeps the admin on a screen that works.
  const { data: factors, error } = await sb.auth.mfa.listFactors();
  if (!error && (factors?.totp?.length ?? 0) === 0) redirect("/signin/mfa-setup");

  return (
    <div className="admin-signin">
      <div className="admin-signin-card">
        <div className="lockup">
          {/* eslint-disable-next-line @next/next/no-img-element -- fixed-height brand lockup, CSS-scaled */}
          <img src="/brand/wordmark-green.png" alt="stablepass." />
          <span className="badge">Admin</span>
        </div>
        <h1>Enter your code.</h1>
        <p className="sub">
          Signed in as {user.email}. One more step — staff accounts need a second factor.
        </p>

        <MfaChallengeForm />

        <div className="legal">Protected by 2FA · Staff sessions audited.</div>
      </div>
    </div>
  );
}
