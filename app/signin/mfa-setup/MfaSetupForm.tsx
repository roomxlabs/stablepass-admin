"use client";

import { useActionState } from "react";
import { verifyEnrolment, type MfaSetupState } from "./actions";

// The code field is the same treatment as the challenge screen (and the
// mockup's "Authenticator code" group in screens/01-signin.html): same
// .input-group / .input-label / .input classes, 0.3em letter-spacing,
// tabular-nums. The factor id rides along hidden so the action verifies the
// exact factor whose QR is on screen.
export default function MfaSetupForm({ factorId }: { factorId: string }) {
  const [state, action, pending] = useActionState<MfaSetupState, FormData>(
    verifyEnrolment,
    {},
  );

  return (
    <form action={action} noValidate>
      <input type="hidden" name="factorId" value={factorId} />

      <div className="input-group">
        <label className="input-label" htmlFor="code">
          Authenticator code
        </label>
        <input
          className="input"
          id="code"
          name="code"
          type="text"
          inputMode="numeric"
          maxLength={6}
          placeholder="000000"
          autoComplete="one-time-code"
          autoFocus
          required
          style={{ letterSpacing: "0.3em", fontVariantNumeric: "tabular-nums" }}
        />
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 7 }}>
          From your Authenticator app
        </div>
      </div>

      {state?.error ? (
        <div className="signin-error" role="alert">
          {state.error}
        </div>
      ) : null}

      <button
        className="btn btn-primary btn-block btn-large"
        type="submit"
        style={{ marginTop: 8 }}
        disabled={pending}
      >
        {pending ? "Verifying…" : "Verify & finish"}
      </button>
    </form>
  );
}
