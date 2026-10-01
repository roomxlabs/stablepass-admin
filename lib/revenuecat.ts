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
  /**
   * True when a subscriber was CREATED in RevenueCat before this failure
   * (ENG-1436). The grant can fail after the ensure leg succeeded, which leaves
   * a real customer behind — ops needs that in the `admin_comp_failed` line to
   * tell it apart from a 404 that changed nothing.
   */
  ensured = false;

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
  return `${subscriberUrl(uid)}/entitlements/${ENTITLEMENT_ID}/${action}`;
}

function subscriberUrl(uid: string): string {
  return `${API_BASE}/subscribers/${encodeURIComponent(uid)}`;
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

/**
 * Create the subscriber if RevenueCat has never seen them (ENG-1436).
 *
 * RevenueCat v1 `GET /v1/subscribers/{app_user_id}` is the documented
 * "Get or Create Customer" endpoint — "Gets the latest Customer Info for the
 * customer with the given App User ID, **or creates a new customer if it
 * doesn't exist**": 200 = found, 201 = created. Confirmed against the live docs
 * on 2026-09-25 (https://www.revenuecat.com/docs/api-v1/customers), which is
 * why this is a plain GET and not a bespoke create call.
 *
 * `uid` is ALWAYS the member being comped — the caller passes the same uid it is
 * granting to, so admin can never bring a third party into existence in
 * RevenueCat (ticket guardrail 3).
 */
export async function ensureSubscriber(
  uid: string,
  fetchImpl: FetchImpl = (input, init) => fetch(input, init),
  { timeoutMs = REVENUECAT_TIMEOUT_MS }: Opts = {},
): Promise<void> {
  const key = secretKey();
  await call(subscriberUrl(uid), { method: "GET", headers: { Authorization: `Bearer ${key}` } }, fetchImpl, timeoutMs);
}

/**
 * Grant the `content` entitlement for `duration`. Throws `RevenueCatError`.
 *
 * A member RevenueCat has never seen (a web signup who never paid, or someone
 * who never opened the app) makes the promotional POST answer **404** — and
 * those members are exactly who comp is for. So a 404 on the FIRST grant means
 * "unknown subscriber": ensure the subscriber exists, then retry the grant
 * exactly once. Every other failure — 5xx, timeout, 401, a network error, and a
 * 404 that survives the retry — still surfaces as `unavailable` (the route's
 * 502 `revenuecat_unavailable`), and there is no loop: at most two grant calls.
 *
 * "404 ⇒ unknown subscriber" is OBSERVED behaviour (the 2026-09-25 incident),
 * NOT a documented contract: RevenueCat's published
 * `openapi-v1-entitlements.yaml` lists only a 201 for this endpoint and
 * documents no error responses. A 404 could in principle also mean "the
 * `content` entitlement does not exist in this project" (a misconfiguration) —
 * in which case the retry still fails and the operator still gets a 502. That
 * is why the recovery is bounded to one retry rather than a general retry rule.
 *
 * `timeoutMs` is the budget for the WHOLE grant, shared across all three
 * possible calls — not per call. Three independent 5s timeouts would put the
 * worst case at 15s, over the platform's function limit, and the operator would
 * get a `FUNCTION_INVOCATION_TIMEOUT` instead of this module's typed failure
 * (and ops would get no `admin_comp_failed` line at all).
 */
export async function grantPromotional(
  uid: string,
  duration: CompDuration,
  fetchImpl: FetchImpl = (input, init) => fetch(input, init),
  { now = new Date(), timeoutMs = REVENUECAT_TIMEOUT_MS }: Opts = {},
): Promise<{ endTimeMs: number; ensured: boolean }> {
  // Validated BEFORE the key is read or anything is sent — `lifetime` (or any
  // value off the list) must never reach RevenueCat, whatever the caller did.
  if (!isCompDuration(duration)) {
    throw new RevenueCatError("invalid_duration", `Unsupported comp duration: ${String(duration)}`);
  }
  const key = secretKey();
  const endTimeMs = addMonthsUtc(now, DURATION_MONTHS[duration]).getTime();
  // One deadline for the whole grant, consumed by every leg (see the doc above).
  const startedAt = Date.now();
  const remainingMs = (): number => {
    const left = timeoutMs - (Date.now() - startedAt);
    if (left <= 0) throw new RevenueCatError("unavailable", `RevenueCat timed out after ${timeoutMs}ms.`);
    return left;
  };

  const grant = () =>
    call(
      entitlementUrl(uid, "promotional"),
      {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        // Computed ONCE, above: the retry must not extend the comp.
        body: JSON.stringify({ end_time_ms: endTimeMs }),
      },
      fetchImpl,
      remainingMs(),
    );

  try {
    await grant();
    return { endTimeMs, ensured: false };
  } catch (e) {
    // ONLY the unknown-subscriber 404 is recoverable. A 5xx/timeout/401 is a
    // real outage or a bad key and must stay `unavailable` → 502, unretried.
    if (!(e instanceof RevenueCatError) || e.status !== 404) throw e;
  }
  await ensureSubscriber(uid, fetchImpl, { timeoutMs: remainingMs() });
  // From here a subscriber EXISTS in RevenueCat, so every failure below has a
  // side effect the operator must be told about.
  try {
    await grant(); // Exactly one retry — a second 404 propagates as `unavailable`.
  } catch (e) {
    if (e instanceof RevenueCatError) e.ensured = true;
    throw e;
  }
  return { endTimeMs, ensured: true };
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
