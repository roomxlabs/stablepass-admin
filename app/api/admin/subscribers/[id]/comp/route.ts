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

function revenueCatFailure(e: unknown): Response {
  if (e instanceof RevenueCatError) {
    if (e.kind === "not_configured") {
      return fail("revenuecat_not_configured", "Comp access is not configured on this server.", 503);
    }
    if (e.kind === "invalid_duration") {
      return fail("invalid_duration", "Choose a duration of 1, 2, 3, 6 or 12 months.", 400);
    }
  }
  return fail("revenuecat_unavailable", "RevenueCat did not confirm the change. Nothing was changed — try again.", 502);
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

  try {
    await grantPromotional(id, duration);
  } catch (e) {
    return revenueCatFailure(e);
  }

  // Audit is a structured log line (no table — `admin_auth_event` is auth-only).
  // Ids and duration only: never the member's email or name.
  console.info(
    JSON.stringify({ event: "admin_comp_granted", adminUid: await adminId(gate.sb), targetUid: id, duration }),
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
    return revenueCatFailure(e);
  }

  console.info(JSON.stringify({ event: "admin_comp_revoked", adminUid: await adminId(gate.sb), targetUid: id }));
  return ok({ revoked: true });
}
