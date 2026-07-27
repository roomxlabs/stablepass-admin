import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import MfaSetupForm from "./MfaSetupForm";
import styles from "./mfa-setup.module.css";

export const metadata: Metadata = {
  title: "Set up 2FA · stablepass admin",
};

// Forced TOTP enrolment (ENG-371) — the destination A1's gate sends an admin to
// when they have a session but nothing enrolled. Reuses screens/01-signin.html's
// .admin-signin / .admin-signin-card shell exactly; only the QR block is new.
//
// THE GATE HERE IS DELIBERATELY INLINE — DO NOT SWAP IT FOR requireAdminPage().
// That helper redirects an AAL1 admin with no factor to THIS route, so calling
// it here is an infinite redirect. The admin this screen exists for must STAY
// here, so the checks are spelled out: no session -> /signin, non-admin ->
// /signin?error=forbidden, already-enrolled -> onward. Everything else renders.
export default async function MfaSetupPage() {
  const sb = await supabaseServer();

  // 1. No session at all: nothing to enrol against.
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/signin");

  // 2. Session, but not an admin. Same destination the rest of the app uses, so
  //    a non-admin is bounced before any factor is created for them and never
  //    sees a QR code.
  const { data: appUser } = await sb
    .from("app_user")
    .select("is_admin")
    .eq("id", user.id)
    .single();
  if (!appUser?.is_admin) redirect("/signin?error=forbidden");

  // auth-js buckets ONLY status==="verified" totp factors into `totp`; `all`
  // carries the unverified ones too. An error here means we cannot tell whether
  // something is already enrolled — enrolling anyway could stack a second factor
  // on a working account, so hand off to the challenge screen, which re-derives
  // the answer for itself (and, because it only bounces back here on a POSITIVE
  // zero-factor read, cannot ping-pong with this one for any stable read —
  // closing the cycle would need listFactors to alternate error/success on
  // consecutive hops).
  const { data: factors, error: factorsError } = await sb.auth.mfa.listFactors();
  if (factorsError || !factors) redirect("/signin/mfa");

  const verified = factors.totp ?? [];
  if (verified.length > 0) {
    // 3. Already enrolled — this screen is not a way to re-enrol over a working
    //    factor. At aal2 they are done; at aal1 they still owe a code, which is
    //    the challenge screen's job, not a second enrolment.
    const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    redirect(aal?.currentLevel === "aal2" ? "/" : "/signin/mfa");
  }

  // 4. Clear out any unverified factor left behind by an abandoned attempt
  //    before enrolling a fresh one. Without this, every revisit stacks another
  //    dead factor and eventually hits the enrolled-factor cap.
  const stale = (factors.all ?? []).filter(
    (f) => f.factor_type === "totp" && f.status !== "verified",
  );
  for (const f of stale) {
    await sb.auth.mfa.unenroll({ factorId: f.id });
  }

  // 5. Fresh enrolment. `qr_code` comes back as an SVG data-URI already — it is
  //    rendered straight into an <img>, which is why this screen needs no QR
  //    library. The secret is shown once, here, to this admin's browser only:
  //    it is never logged, never persisted by this app, and never leaves the
  //    response.
  //
  //    `issuer` and `friendlyName` are what the admin's authenticator app shows
  //    in its list. Without them GoTrue falls back to the site URL's host, so a
  //    factor enrolled against a dev server reads "localhost:3000" — useless in
  //    an app that already holds a dozen entries. Both are baked into the QR at
  //    scan time, so changing them here only affects NEW enrolments; anyone who
  //    already scanned keeps the old label until they re-enrol.
  const { data: enrolled, error: enrollError } = await sb.auth.mfa.enroll({
    factorType: "totp",
    issuer: "StablePass Admin",
    friendlyName: `StablePass Admin (${user.email})`,
  });
  // Guard the PAYLOAD, not just the error: a factor-cap rejection or any
  // proxy/mock that answers 200 with a body missing `totp` would otherwise
  // throw on `.qr_code` and turn a recoverable state into a 500.
  const totp = enrolled?.totp?.qr_code ? enrolled : null;

  return (
    <div className="admin-signin">
      <div className="admin-signin-card">
        <div className="lockup">
          {/* eslint-disable-next-line @next/next/no-img-element -- fixed-height brand lockup, CSS-scaled */}
          <img src="/brand/wordmark-green.png" alt="stablepass." />
          <span className="badge">Admin</span>
        </div>
        <h1>Set up 2FA.</h1>

        {enrollError || !totp ? (
          <>
            <p className="sub">Signed in as {user.email}.</p>
            <div className="signin-error" role="alert">
              We couldn&apos;t start enrolment just now. Reload the page to try again.
            </div>
            <div className="legal">Protected by 2FA · Staff sessions audited.</div>
          </>
        ) : (
          <>
            <p className="sub">
              Scan this with your authenticator app — Google Authenticator, Microsoft
              Authenticator and 1Password all work.
            </p>

            <div className={styles.qrPanel}>
              {/* eslint-disable-next-line @next/next/no-img-element -- Supabase returns an SVG data-URI; next/image cannot optimise it */}
              <img className={styles.qr} src={totp.totp.qr_code} alt="" />
            </div>

            <div className={styles.secretBlock}>
              <div className={styles.secretLabel}>Can&apos;t scan? Enter this key instead</div>
              <code className={styles.secret}>{totp.totp.secret}</code>
            </div>

            <p className={styles.note}>
              This code replaces any earlier setup you started — if you already scanned an
              older one, scan this one again.
            </p>

            <MfaSetupForm factorId={totp.id} />

            <div className="legal">Protected by 2FA · Staff sessions audited.</div>
          </>
        )}
      </div>
    </div>
  );
}
