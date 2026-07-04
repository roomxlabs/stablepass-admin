// Browser Supabase client (anon). RLS applies. No raw token in JS storage.
import { createBrowserClient } from "@supabase/ssr";
export const supabaseBrowser = () =>
  createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
