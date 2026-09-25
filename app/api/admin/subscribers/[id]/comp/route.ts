import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAdmin } from "@/lib/auth/admin";
import { fail, ok } from "@/lib/api/envelope";
import { isUuid } from "@/lib/uuid";
import {
  grantPromotional,
  isCompDuration,
  revokePromotional,
  RevenueCatError,
} from "@/lib/revenuecat";

// POST   /api/admin/subscribers/:id/comp  { duration } — grant complimentary access
// DELETE /api/admin/subscribers/:id/comp               — revoke it
// (ENG-1194, epic ENG-1183 decision 12)
//
// `:id` is the member's auth uid (`subscription.user_id`), which is also their
// RevenueCat App User ID — NOT the subscription row id.
//
// This route NEVER writes `subscription`. It asks RevenueCat to grant/revoke the
// `content` entitlement; RevenueCat's webhook then drives be's service-role
// writer, which stamps `provider = 'promotional'`. The only database read here
// is the admin gate itself.
//
// Order is fixed: gate → id → body. A non-admin learns nothing about which ids
// or durations are valid, and a malformed id never reaches the RevenueCat URL.

type Ctx = { params: Promise<{ id: string }> };

function revenueCatFailure(e: unknown, context: Record<string, unknown>): Response {
  // Failures leave a trace too (status + kind only, never a response body), so
  // ops can tell a rejected key (401) from an outage.
  console.warn(
    JSON.stringify({
      event: "admin_comp_failed",
      ...context,
      kind: e instanceof RevenueCatError ? e.kind : "unknown",
      status: e instanceof RevenueCatError ? (e.status ?? null) : null,
    }),
  );
  if (e instanceof RevenueCatError) {
    if (e.kind === "not_configured") {
      return fail("revenuecat_not_configured", "Comp access is not configured on this server.", 503);
    }
    if (e.kind === "invalid_duration") {
      return fail("invalid_duration", "Choose a duration of 1, 2, 3, 6 or 12 months.", 400);
    }
  }
  return fail("revenuecat_unavailable", "RevenueCat did not confirm the change. It may not have been applied — try again.", 502);
}

async function adminId(sb: SupabaseClient): Promise<string | null> {
  const { data } = await sb.auth.getUser();
  return data.user?.id ?? null;
}

export async function POST(req: Request, { params }: Ctx) {
  const gate = await requireAdmin();
  if ("res" in gate) return gate.res;

  const { id } = await params;
  if (!isUuid(id)) return fail("invalid_id", "Member id must be a uuid.", 400);

  const body = (await req.json().catch(() => null)) as { duration?: unknown } | null;
  const duration = body?.duration;
  // `lifetime` is rejected here as `invalid_duration` — it is simply not in the set.
  if (!isCompDuration(duration)) {
    return fail("invalid_duration", "Choose a duration of 1, 2, 3, 6 or 12 months.", 400);
  }

  // The target must be a REAL member before we go anywhere near RevenueCat
  // (ENG-1436). Granting now CREATES the subscriber when RevenueCat has never
  // seen them, so without this a mistyped-but-well-formed uuid would mint a
  // permanent RevenueCat customer holding `content` for nobody — and answer 200.
  // Previously the grant's own 404 made that case inert; the fix removes that
  // accident, so the check has to be explicit.
  //
  // `subscription` is the right table: `handle_new_user` gives EVERY signup a
  // row (stablepass-be `20260905120000_delete_account.sql`), including the web
  // signup who never paid and never opened the app — exactly the member this
  // ticket is about. This is a READ under the admin's own RLS client; the route
  // still never WRITES `subscription` (epic ENG-1183 decision 12).
  const { data: member } = await gate.sb.from("subscription").select("user_id").eq("user_id", id).maybeSingle();
  if (!member) return fail("member_not_found", "No member with that id.", 404);

  // A member RevenueCat has never seen is created on the way through
  // (ENG-1436) — `ensured` records that, and it is the ONLY subscriber this
  // request may bring into existence.
  let ensured = false;
  try {
    ({ ensured } = await grantPromotional(id, duration));
  } catch (e) {
    // `ensured` on the error: the grant can fail AFTER the subscriber was
    // created, which leaves a real customer behind. Ops must be able to find it.
    return revenueCatFailure(e, {
      adminUid: await adminId(gate.sb),
      targetUid: id,
      duration,
      ensured: e instanceof RevenueCatError ? e.ensured : false,
    });
  }

  // Audit is a structured log line (no table — `admin_auth_event` is auth-only).
  // Ids and duration only: never the member's email or name.
  console.info(
    JSON.stringify({ event: "admin_comp_granted", adminUid: await adminId(gate.sb), targetUid: id, duration, ensured }),
  );
  return ok({ granted: true, duration });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const gate = await requireAdmin();
  if ("res" in gate) return gate.res;

  const { id } = await params;
  if (!isUuid(id)) return fail("invalid_id", "Member id must be a uuid.", 400);

  try {
    await revokePromotional(id);
  } catch (e) {
    return revenueCatFailure(e, { adminUid: await adminId(gate.sb), targetUid: id, action: "revoke" });
  }

  console.info(JSON.stringify({ event: "admin_comp_revoked", adminUid: await adminId(gate.sb), targetUid: id }));
  return ok({ revoked: true });
}
