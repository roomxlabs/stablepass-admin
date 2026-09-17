"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
// TYPE-ONLY. `lib/revenuecat` is server-only (it reads the RevenueCat secret
// key); a value import here would drag it into the browser bundle. The grep
// guard in lib/revenuecat.test.ts fails on anything but `import type`.
import type { CompDuration } from "@/lib/revenuecat";
import { showToast } from "../Toast";

// Per-row "comp access" island for the Subscribers table (ENG-1194).
//
// No mockup exists for this (same gap as ENG-982 / ENG-1193), so it is composed
// from what the screen already has: chip-weight buttons in the `.adm-table`
// cell, the posts row-action treatment for the destructive one, the
// DangerDelete confirm (`window.confirm` in full sentences) for Revoke, and the
// one shared toast region for the outcome.
//
// EVENTUAL CONSISTENCY IS THE COPY. The BFF only asks RevenueCat to grant; the
// row changes when RevenueCat's webhook lands a few seconds later. So success
// says "once RevenueCat confirms", and the page refreshes once rather than
// polling — a row that still reads the old status right after is expected.

// `Record<CompDuration, …>` makes this exhaustive against the server's list at
// compile time, so the menu cannot offer a duration the route would 400.
const DURATION_LABELS: Record<CompDuration, string> = {
  monthly: "1 month",
  two_month: "2 months",
  three_month: "3 months",
  six_month: "6 months",
  yearly: "12 months",
};
const DURATIONS = Object.keys(DURATION_LABELS) as CompDuration[];

export const GRANTED_TOAST =
  "Complimentary access granted — it appears once RevenueCat confirms (a few seconds).";
export const REVOKED_TOAST =
  "Complimentary access revoked — the row updates once RevenueCat confirms (a few seconds).";

const ERROR_COPY: Record<string, string> = {
  revenuecat_unavailable: "RevenueCat didn't confirm the change, so nothing was changed. Try again.",
  revenuecat_not_configured: "Comp access isn't configured on this server yet (no RevenueCat key).",
};

async function send(endpoint: string, init: RequestInit): Promise<void> {
  const res = await fetch(endpoint, init);
  if (res.ok) return;
  const json = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  const code = json?.error?.code ?? "";
  throw new Error(ERROR_COPY[code] ?? json?.error?.message ?? `Request failed (${res.status}).`);
}

export default function CompAccess({
  userId,
  memberLabel,
  canRevoke,
}: {
  /** `subscription.user_id` — the RevenueCat App User ID. */
  userId: string;
  /** Name or email, for the accessible labels and the revoke confirm. */
  memberLabel: string;
  /** Row is `promotional` and still entitled — decided server-side. */
  canRevoke: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [duration, setDuration] = useState<CompDuration>("monthly");
  const [busy, setBusy] = useState(false);
  const endpoint = `/api/admin/subscribers/${encodeURIComponent(userId)}/comp`;

  async function run(init: RequestInit, success: string) {
    setBusy(true);
    try {
      await send(endpoint, init);
      showToast(success, "success");
      setOpen(false);
      startTransition(() => router.refresh());
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Comp access failed.", "error");
    } finally {
      setBusy(false);
    }
  }

  function grant() {
    void run(
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ duration }) },
      GRANTED_TOAST,
    );
  }

  function revoke() {
    const confirmText =
      `Revoke complimentary access for ${memberLabel}?\n\n` +
      "Their access ends as soon as RevenueCat confirms. A subscription they pay for themselves is not affected.";
    if (typeof window !== "undefined" && !window.confirm(confirmText)) return;
    void run({ method: "DELETE" }, REVOKED_TOAST);
  }

  if (open) {
    return (
      <div
        className="subs-comp-confirm"
        role="group"
        aria-label={`Grant complimentary access to ${memberLabel}`}
        data-testid="comp-confirm"
      >
        <span className="label" aria-hidden="true">
          Comp for
        </span>
        <select
          className="subs-comp-select"
          aria-label={`Complimentary access duration for ${memberLabel}`}
          value={duration}
          disabled={busy}
          onChange={(e) => setDuration(e.target.value as CompDuration)}
          data-testid="comp-duration"
        >
          {DURATIONS.map((d) => (
            <option key={d} value={d}>
              {DURATION_LABELS[d]}
            </option>
          ))}
        </select>
        <button type="button" className="subs-comp-btn primary" disabled={busy} onClick={grant} data-testid="comp-grant">
          {busy ? "Granting…" : "Grant"}
        </button>
        <button type="button" className="subs-comp-btn" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="subs-comp-actions">
      <button
        type="button"
        className="subs-comp-btn"
        disabled={busy}
        aria-label={`Comp access for ${memberLabel}`}
        onClick={() => setOpen(true)}
        data-testid="comp-open"
      >
        Comp
      </button>
      {canRevoke ? (
        <button
          type="button"
          className="subs-comp-btn destructive"
          disabled={busy}
          aria-label={`Revoke complimentary access for ${memberLabel}`}
          onClick={revoke}
          data-testid="comp-revoke"
        >
          {busy ? "Revoking…" : "Revoke"}
        </button>
      ) : null}
    </div>
  );
}
