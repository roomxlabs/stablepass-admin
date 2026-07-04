import { supabaseServer } from "@/lib/supabase/server";
import { fail, UNAUTH } from "@/lib/api/envelope";
import type { SupabaseClient } from "@supabase/supabase-js";

// Resolve the caller and require is_admin. Returns { sb } on success, or a Response to return.
export async function requireAdmin(): Promise<{ sb: SupabaseClient } | { res: Response }> {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { res: UNAUTH() };
  const { data } = await sb.from("app_user").select("is_admin").eq("id", user.id).single();
  if (!data?.is_admin) return { res: fail("forbidden", "Admin only.", 403) };
  return { sb };
}
