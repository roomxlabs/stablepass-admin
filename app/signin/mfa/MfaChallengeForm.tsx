"use client";

import { useActionState } from "react";
import { verifyMfa, type MfaState } from "./actions";

// The code field is lifted verbatim from the mockup's "Authenticator code"
// group (screens/01-signin.html): same .input-group / .input-label / .input
// classes, same 0.3em letter-spacing + tabular-nums, same helper line. It just
// moves to its own card now that sign-in is two steps.
export default function MfaChallengeForm() {
  const [state, action, pending] = useActionState<MfaState, FormData>(verifyMfa, {});

  return (
    <form action={action} noValidate>
      <div className="input-group">
        <label className="input-label" htmlFor="code">Authenticator code</label>
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
        <div className="signin-error" role="alert">{state.error}</div>
      ) : null}

      <button
        className="btn btn-primary btn-block btn-large"
        type="submit"
        style={{ marginTop: 8 }}
        disabled={pending}
      >
        {pending ? "Verifying…" : "Verify"}
      </button>
    </form>
  );
}
