"use client";

import { useActionState } from "react";
import { signIn, type SignInState } from "./actions";

export default function SignInForm({ gateMessage }: { gateMessage?: string }) {
  const [state, action, pending] = useActionState<SignInState, FormData>(
    signIn,
    { error: gateMessage },
  );

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
        <input
          className="input"
          id="password"
          name="password"
          type="password"
          placeholder="••••••••••"
          autoComplete="current-password"
          required
        />
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
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
