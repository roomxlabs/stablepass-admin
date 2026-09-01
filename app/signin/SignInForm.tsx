"use client";

import { useActionState, useState } from "react";
import { signIn, type SignInState } from "./actions";

/** Feather eye / eye-off — the reveal-password affordance (1 Sep 2026). */
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {off ? (
        <>
          <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
          <path d="M1 1l22 22" />
        </>
      ) : (
        <>
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  );
}

export default function SignInForm({ gateMessage }: { gateMessage?: string }) {
  const [state, action, pending] = useActionState<SignInState, FormData>(
    signIn,
    { error: gateMessage },
  );
  const [revealed, setRevealed] = useState(false);

  return (
    <form action={action} noValidate>
      <div className="input-group">
        <label className="input-label" htmlFor="email">Staff email</label>
        <input
          className="input"
          id="email"
          name="email"
          type="email"
          placeholder="you@stablepass.co"
          autoComplete="email"
          required
        />
      </div>
      <div className="input-group">
        <label className="input-label" htmlFor="password">Password</label>
        <div style={{ position: "relative" }}>
          <input
            className="input"
            id="password"
            name="password"
            type={revealed ? "text" : "password"}
            placeholder="••••••••••"
            autoComplete="current-password"
            style={{ paddingRight: 44 }}
            required
          />
          <button
            type="button"
            aria-label={revealed ? "Hide password" : "Show password"}
            onClick={() => setRevealed((r) => !r)}
            style={{
              position: "absolute",
              right: 0,
              top: 0,
              bottom: 0,
              width: 40,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--muted, #6b6b6b)",
            }}
          >
            <EyeIcon off={revealed} />
          </button>
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
        {pending ? "Signing in…" : "Continue"}
      </button>
    </form>
  );
}
