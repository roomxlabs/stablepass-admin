import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import SignInForm from "./SignInForm";

export const metadata: Metadata = {
  title: "Sign in · stablepass admin",
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // Already signed in as an admin? Skip straight to the dashboard.
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (user) {
    const { data } = await sb.from("app_user").select("is_admin").eq("id", user.id).single();
    if (data?.is_admin) redirect("/");
  }

  const { error } = await searchParams;
  const gateMessage =
    error === "forbidden"
      ? "That account isn't an admin. Ask an owner for access."
      : undefined;

  return (
    <div className="admin-signin">
      <div className="admin-signin-card">
        <div className="lockup">
          {/* eslint-disable-next-line @next/next/no-img-element -- fixed-height brand lockup, CSS-scaled */}
          <img src="/brand/wordmark-green.png" alt="stablepass." />
          <span className="badge">Admin</span>
        </div>
        <h1>Sign in.</h1>
        <p className="sub">
          Stablepass internal team only. Member sign-in is at app.stablepass.co.
        </p>

        <SignInForm gateMessage={gateMessage} />

        <div className="legal">Staff sessions are audited. One active device per account.</div>
      </div>
    </div>
  );
}
