// RevenueCat promotional entitlements — admin "comp access" (ENG-1194, epic ENG-1183).
//
// SERVER-ONLY. Import this from `app/api/**` and nowhere else: it reads
// REVENUECAT_SECRET_API_KEY, a secret key that can grant paid access to any
// member (guardrail 8). `lib/revenuecat.test.ts` greps every "use client" file
// to prove neither the key name nor a value import of this module reaches the
// browser bundle — a client file may only `import type` from here.
//
// ADMIN NEVER WRITES `subscription`. A grant goes RevenueCat REST → RevenueCat
// webhook → be `revenuecat-webhook` (service role) → row with
// `provider = 'promotional'`. Nothing in this module or its route touches the
// database, which is why the screen's copy says the row updates "once RevenueCat
// confirms".
//
// Endpoints verified live on 2026-09-17 against RevenueCat's published OpenAPI
// (https://www.revenuecat.com/docs/redocusaurus/openapi-v1-entitlements.yaml):
//   POST /v1/subscribers/{app_user_id}/entitlements/{id}/promotional        → 201
//   POST /v1/subscribers/{app_user_id}/entitlements/{id}/revoke_promotionals → 200
// DRIFT FROM THE TICKET: the grant's `duration` body field is marked
// `deprecated: true` there ("If not provided then `end_time_ms` must be
// provided"). So the admin-facing contract keeps the ticket's duration ids, but
// the wire body is the non-deprecated `end_time_ms`, computed here. That also
// makes the expiry an explicit, tested number instead of RevenueCat's own
// reading of "monthly", and makes a null (lifetime) expiry unrepresentable.

/** The content entitlement (epic decision 10 — locked identifier). */
export const ENTITLEMENT_ID = "content";

const API_BASE = "https://api.revenuecat.com/v1";
export const REVENUECAT_TIMEOUT_MS = 5000;

// The ONLY durations admin may grant, in calendar months. `lifetime` is absent
// on purpose (epic decision 12): a null expiration collides with the webhook's
// advance-only period rule, and be ENG-1186 skips a lifetime entitlement, so a
// lifetime grant would silently never reach the row.
const DURATION_MONTHS = {
  monthly: 1,
  two_month: 2,
  three_month: 3,
  six_month: 6,
  yearly: 12,
} as const;

export type CompDuration = keyof typeof DURATION_MONTHS;

export const COMP_DURATIONS = Object.keys(DURATION_MONTHS) as CompDuration[];

/** Own-key lookup, so `"toString"` / `"__proto__"` are not durations either. */
export function isCompDuration(v: unknown): v is CompDuration {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(DURATION_MONTHS, v);
}

export type RevenueCatErrorKind = "not_configured" | "invalid_duration" | "unavailable";

/** Typed failure, so the route maps it to 503 / 400 / 502 without string-matching. */
export class RevenueCatError extends Error {
  constructor(
    readonly kind: RevenueCatErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RevenueCatError";
  }
}

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

type Opts = { now?: Date; timeoutMs?: number };

/**
 * `now` + N calendar months, in UTC, with the day clamped to the target month's
 * length — 31 Jan + 1 month is 28/29 Feb, never 2/3 Mar.
 */
export function addMonthsUtc(now: Date, months: number): Date {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      y,
      m,
      Math.min(now.getUTCDate(), lastDay),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  );
}

function secretKey(): string {
  const key = process.env.REVENUECAT_SECRET_API_KEY;
  if (!key) throw new RevenueCatError("not_configured", "REVENUECAT_SECRET_API_KEY is not set.");
  return key;
}

// `uid` is the RevenueCat App User ID = Supabase auth uid. The route has already
// rejected anything that is not a uuid; encoding it anyway means this module is
// safe on its own and a path segment can never be smuggled into the URL.
function entitlementUrl(uid: string, action: "promotional" | "revoke_promotionals"): string {
  return `${API_BASE}/subscribers/${encodeURIComponent(uid)}/entitlements/${ENTITLEMENT_ID}/${action}`;
}

async function call(url: string, init: RequestInit, fetchImpl: FetchImpl, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (e) {
    const aborted = controller.signal.aborted;
    throw new RevenueCatError(
      "unavailable",
      aborted ? `RevenueCat timed out after ${timeoutMs}ms.` : `RevenueCat request failed: ${(e as Error)?.message ?? e}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // Body deliberately not echoed: it can carry the subscriber object.
    throw new RevenueCatError("unavailable", `RevenueCat answered ${res.status}.`, res.status);
  }
}

/** Grant the `content` entitlement for `duration`. Throws `RevenueCatError`. */
export async function grantPromotional(
  uid: string,
  duration: CompDuration,
  fetchImpl: FetchImpl = (input, init) => fetch(input, init),
  { now = new Date(), timeoutMs = REVENUECAT_TIMEOUT_MS }: Opts = {},
): Promise<{ endTimeMs: number }> {
  // Validated BEFORE the key is read or anything is sent — `lifetime` (or any
  // value off the list) must never reach RevenueCat, whatever the caller did.
  if (!isCompDuration(duration)) {
    throw new RevenueCatError("invalid_duration", `Unsupported comp duration: ${String(duration)}`);
  }
  const key = secretKey();
  const endTimeMs = addMonthsUtc(now, DURATION_MONTHS[duration]).getTime();
  await call(
    entitlementUrl(uid, "promotional"),
    {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ end_time_ms: endTimeMs }),
    },
    fetchImpl,
    timeoutMs,
  );
  return { endTimeMs };
}

/** Revoke every promotional grant of `content`. Throws `RevenueCatError`. */
export async function revokePromotional(
  uid: string,
  fetchImpl: FetchImpl = (input, init) => fetch(input, init),
  { timeoutMs = REVENUECAT_TIMEOUT_MS }: Opts = {},
): Promise<void> {
  const key = secretKey();
  await call(
    entitlementUrl(uid, "revoke_promotionals"),
    { method: "POST", headers: { Authorization: `Bearer ${key}` } },
    fetchImpl,
    timeoutMs,
  );
}
