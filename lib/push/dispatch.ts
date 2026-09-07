// Server-only: reads PUSH_DISPATCH_SECRET, must never be imported by a client component.
import type { SupabaseClient } from "@supabase/supabase-js";

// push-dispatch (the be Edge Function) runs with verify_jwt=false — Supabase
// never checks a caller JWT before invoking it — so the ONLY authentication
// it has (once it lands) is this shared secret, sent as `x-dispatch-secret`.
// Once roomxlabs/stablepass-be#68 (ENG-948) lands, push-dispatch requires this
// header and returns 401 `{error:"unauthorized"}` before parsing the body;
// until then the header is simply ignored by the deployed function.
// `PUSH_DISPATCH_SECRET` must therefore be a server-only env var (never
// `NEXT_PUBLIC_...`) and must match the value configured on the Supabase
// project.
export const DISPATCH_SECRET_HEADER = "x-dispatch-secret";

export type NewPostDispatch = {
  type: "new_post";
  horseId: string;
  targetType: "post";
  targetId: string;
  title: string;
  body: string;
};

// Fans out a `new_post` push via push-dispatch. This is best-effort: a push
// failure (missing secret, network error, push-dispatch 401/500, etc.) must
// never un-publish the post it's reporting on, so every failure mode here is
// swallowed and logged rather than thrown. Callers get 0 notifications sent
// rather than a broken publish.
export async function dispatchNewPost(
  sb: SupabaseClient,
  payload: NewPostDispatch,
): Promise<number> {
  try {
    const secret = process.env.PUSH_DISPATCH_SECRET;
    if (!secret) {
      console.error(
        "PUSH_DISPATCH_SECRET is unset — push-dispatch will reject with 401 and no push will be delivered",
      );
      return 0;
    }

    const { data, error } = await sb.functions.invoke("push-dispatch", {
      body: payload,
      headers: { [DISPATCH_SECRET_HEADER]: secret },
    });
    if (error) {
      console.error("push-dispatch new_post failed", error);
      return 0;
    }
    const sent = (data as { notificationsSent?: unknown } | null)?.notificationsSent;
    return typeof sent === "number" ? sent : 0;
  } catch (e) {
    console.error("push-dispatch new_post failed", e);
    return 0;
  }
}
