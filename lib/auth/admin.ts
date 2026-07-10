import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { fail, UNAUTH } from "@/lib/api/envelope";
import type { SupabaseClient, User } from "@supabase/supabase-js";

// Resolve the caller and require is_admin. Returns { sb } on success, or a Response to return.
// Used by every app/api/admin/* route handler (401 no session, 403 non-admin).
export async function requireAdmin(): Promise<{ sb: SupabaseClient } | { res: Response }> {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { res: UNAUTH() };
  const { data } = await sb.from("app_user").select("is_admin").eq("id", user.id).single();
  if (!data?.is_admin) return { res: fail("forbidden", "Admin only.", 403) };
  return { sb };
}

// Server-Component / layout variant of the gate. A React tree can't return a
// Response, so the not-authorized branches redirect instead of 401/403-ing:
//   - no session  -> /signin
//   - not is_admin -> /signin?error=forbidden  (the "403 / redirect" the ticket allows)
// On success returns the caller's RLS client + the authenticated user so the
// (dash) shell can render the signed-in identity. Gates every (dash) page.
export async function requireAdminPage(): Promise<{ sb: SupabaseClient; user: User }> {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/signin");
  const { data } = await sb.from("app_user").select("is_admin").eq("id", user.id).single();
  if (!data?.is_admin) redirect("/signin?error=forbidden");
  return { sb, user };
}
