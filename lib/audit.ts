// Admin auth audit trail (ENG-370) — the write half of stablepass-be's
// `admin_auth_event` (ENG-369). Thin wrapper over the two SECURITY DEFINER RPCs
// that migration installs.
//
// THERE ARE TWO RPCs, AND PICKING THE WRONG ONE FAILS SILENTLY:
//
//   log_admin_signin_fail(p_email, p_ip, p_user_agent)
//     Granted to anon. `signin_fail` is hard-coded in the body. This is the ONLY
//     function a sessionless caller can write through.
//
//   log_admin_auth_event(p_event, p_email, p_ip, p_user_agent)
//     Granted to authenticated + service_role only, AND its body carries an
//     in-body guard (`auth.uid() is not null or role = 'service_role'`). Called
//     without a session it inserts ZERO ROWS and still returns 204 — a wrong
//     call is a silent no-op, not an error. So:
//       * a failed password MUST go through log_admin_signin_fail (no session
//         exists at that point — signInWithPassword just failed);
//       * `mfa_fail` MUST be logged BEFORE signOut(), never after, or the row
//         is silently dropped.
//
// `p_ip` is typed `inet`: a malformed value raises 22P02 from the ARGUMENT CAST
// before the never-raise body runs. X-Forwarded-For is routinely a
// comma-separated list ("client, proxy1, proxy2"), which is not a valid inet —
// see parseIp below. Belt and braces, every call is wrapped so a logging
// failure can never break sign-in (guardrail: "the audit call must never break
// sign-in").
import { headers } from "next/headers";
import { supabaseServer } from "@/lib/supabase/server";

// Events this app writes. `mfa_enrolled` is A2's; `mfa_reset` is the operator
// script's. All six are accepted by the RPC's check constraint.
export type AdminAuthEvent = "signin_ok" | "signin_fail" | "mfa_ok" | "mfa_fail";

// Just the slice of the Supabase client we use, so callers can hand us the
// client they already hold (important for mfa_fail: it must be the same,
// still-authenticated client, called before signOut()).
type RpcResult = { error?: { code?: string; message?: string } | null } | null | undefined;
type AuditClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<RpcResult> };

/**
 * Run an audit RPC. Never throws, and never lets a caller wait on a decision.
 *
 * postgrest-js RESOLVES with `{ data, error }` — it does not reject — so a
 * try/catch alone would make every real failure mode invisible: a 22P02 bad
 * `inet` cast, a renamed function (PGRST202), a revoked grant, and a genuine
 * success all look identical. Worse, calling the authenticated RPC while anon
 * returns a clean 204 having written nothing. So we inspect `error` and warn;
 * we still never rethrow, because sign-in must not fail when auditing does.
 */
async function runRpc(sb: AuditClient, fn: string, args: Record<string, unknown>): Promise<void> {
  try {
    const res = await sb.rpc(fn, args);
    if (res?.error) {
      console.warn(`[audit] ${fn} failed`, res.error.code ?? "", res.error.message ?? "");
    }
  } catch (e) {
    console.warn(`[audit] ${fn} threw`, e);
  }
}

const MAX_UA = 512; // matches the RPC's own left(p_user_agent, 512)

/**
 * Reduce a forwarded-for style header to a single value Postgres will accept as
 * `inet`, or null. Never throws.
 *
 * Handles: a comma-separated XFF chain (first hop wins), an IPv4 `host:port`,
 * bracketed IPv6 (`[::1]:443`). Anything not recognisably an address — a
 * hostname, "unknown", a CIDR range, junk — becomes null, because null is a
 * legal `inet` and a bad cast is a 22P02 raised inside the sign-in path.
 */
function isIpv4(s: string): boolean {
  const parts = s.split(".");
  return (
    parts.length === 4 && parts.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)
  );
}

/**
 * Strict IPv6. Counts 16-bit groups exactly, because a PARTIAL address is the
 * dangerous case: "1:2" and ":::" look plausible but Postgres rejects both with
 * 22P02, and a rejected cast means the audit row is silently never written.
 * An IPv4 tail ("::ffff:192.0.2.1", the routine dual-stack form) counts as two
 * groups. Zone ids ("fe80::1%eth0") are rejected — `inet` won't take them.
 */
function isIpv6(v: string): boolean {
  if (!v.includes(":")) return false;
  if (/[^0-9a-fA-F:.]/.test(v)) return false;

  const halves = v.split("::");
  if (halves.length > 2) return false; // more than one "::" run

  // Count the groups on one side of an optional "::". null = malformed.
  const side = (s: string, allowV4Tail: boolean): number | null => {
    if (s === "") return 0;
    const toks = s.split(":");
    let n = 0;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if (t === "") return null; // stray/leading/trailing colon
      if (allowV4Tail && i === toks.length - 1 && t.includes(".")) {
        if (!isIpv4(t)) return null;
        n += 2;
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(t)) return null;
      n += 1;
    }
    return n;
  };

  if (halves.length === 1) return side(v, true) === 8; // no "::" → must be complete

  const left = side(halves[0]!, false);
  const right = side(halves[1]!, true);
  if (left === null || right === null) return false;
  return left + right <= 7; // "::" stands for at least one zero group
}

export function parseIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let v = raw.split(",")[0]!.trim();
  if (!v) return null;

  // [::1]:443 / [2001:db8::1]
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(v);
  if (bracketed) v = bracketed[1]!;

  // 1.2.3.4:5678 — strip the port (a single colon with a v4-looking left side)
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(v)) v = v.slice(0, v.lastIndexOf(":"));

  if (isIpv4(v)) return v;
  if (isIpv6(v)) return v;
  return null;
}

/** IP + user-agent of the current request. Never throws (headers() can be unavailable). */
async function requestMeta(): Promise<{ ip: string | null; ua: string | null }> {
  try {
    const h = await headers();
    const ip = parseIp(h.get("x-forwarded-for")) ?? parseIp(h.get("x-real-ip"));
    return { ip, ua: h.get("user-agent")?.slice(0, MAX_UA) ?? null };
  } catch {
    return { ip: null, ua: null };
  }
}

async function client(sb?: AuditClient): Promise<AuditClient> {
  return sb ?? ((await supabaseServer()) as unknown as AuditClient);
}

/**
 * Log a FAILED PASSWORD attempt. Uses the anon-callable RPC because at this
 * point signInWithPassword() has failed and there is no session — the general
 * RPC would write nothing and report success.
 */
export async function logAdminSignInFail(email: string, sb?: AuditClient): Promise<void> {
  try {
    const { ip, ua } = await requestMeta();
    await runRpc(await client(sb), "log_admin_signin_fail", {
      p_email: email,
      p_ip: ip,
      p_user_agent: ua,
    });
  } catch {
    // Swallowed on purpose: audit is best-effort, sign-in is not.
  }
}

/**
 * Log an event that happens WITH a session in hand (signin_ok / mfa_ok /
 * mfa_fail). The RPC resolves attribution from auth.uid(); `email` is only the
 * sessionless fallback, but we pass it anyway.
 *
 * Caller contract: there must be a live session when this runs. For `mfa_fail`
 * that means calling it BEFORE signOut().
 */
export async function logAdminAuthEvent(
  event: AdminAuthEvent,
  email: string,
  sb?: AuditClient,
): Promise<void> {
  try {
    const { ip, ua } = await requestMeta();
    await runRpc(await client(sb), "log_admin_auth_event", {
      p_event: event,
      p_email: email,
      p_ip: ip,
      p_user_agent: ua,
    });
  } catch {
    // Swallowed on purpose: audit is best-effort, sign-in is not.
  }
}
