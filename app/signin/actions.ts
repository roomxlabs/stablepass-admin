"use server";

import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";

export type SignInState = { error?: string };

// BFF sign-in: credentials go to the server, Supabase mints the session, and
// @supabase/ssr writes it to httpOnly cookies (never exposed to browser JS).
// Only an app_user with is_admin=true may in; anyone else is signed straight
// back out. On success we land on the gated dashboard at "/".
export async function signIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };

  const sb = await supabaseServer();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error || !data.user) return { error: "Wrong email or password." };

  const { data: profile } = await sb
    .from("app_user")
    .select("is_admin")
    .eq("id", data.user.id)
    .single();
  if (!profile?.is_admin) {
    // Not staff — don't leave a live session lying around.
    await sb.auth.signOut();
    return { error: "That account isn't an admin." };
  }

  // NOTE: single-device enforcement (revoke the account's other sessions on a
  // fresh sign-in) is owned by the backend session layer; the gate here only
  // asserts is_admin. See stablepass-admin/.rx/guardrails.md.
  redirect("/");
}

// Clear the session and return to the sign-in screen.
export async function signOut(): Promise<void> {
  const sb = await supabaseServer();
  await sb.auth.signOut();
  redirect("/signin");
}
