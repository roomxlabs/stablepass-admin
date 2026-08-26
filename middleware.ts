// Session-refresh middleware — the missing piece behind "I keep getting logged
// out while I'm working" (Justin, 26 Aug 2026).
//
// WHY THIS IS REQUIRED. With @supabase/ssr the access token is short-lived and
// is refreshed by exchanging the (rotating, single-use) refresh token. That
// exchange only STICKS if the new cookies can be written back to the response.
// A Server Component CANNOT set cookies mid-render — see the swallowed `catch`
// in lib/supabase/server.ts — so when the token expired during a page render,
// the refresh either never persisted or consumed the refresh token without
// saving its replacement. The next request then presented a spent refresh
// token, the session failed, `getUser()` returned null, and requireAdminPage
// redirected to /signin. That is the logout.
//
// Middleware runs BEFORE the render and CAN write cookies onto the response, so
// this is the one place the rotated token can be saved. Calling `getUser()`
// here triggers the refresh and the `setAll` below persists it. As long as the
// admin is active (and the refresh token is still valid) they stay signed in.
//
// This does NOT gate access — page/route auth stays in requireAdminPage /
// requireAdmin (incl. the AAL2/MFA checks). Its only job is to keep the session
// token fresh. Per the Supabase guidance, nothing runs between createServerClient
// and getUser(), and the supabaseResponse is returned unchanged.
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Refreshes the session if the access token is stale, and `setAll` above
  // writes the rotated cookies onto `supabaseResponse`. Do not add code between
  // the client creation and this call.
  await supabase.auth.getUser();

  return supabaseResponse;
}

export const config = {
  // Run on every route EXCEPT Next internals and static asset files — those
  // carry no session to refresh and only add latency.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
