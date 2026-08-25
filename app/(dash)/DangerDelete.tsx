"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// The shared "Danger zone" panel on the horse and trainer edit screens.
//
// Deliberately DUMB: the blocking counts are read server-side by the page that
// renders it and arrive here already turned into `blockedReason`. That is what
// lets the button be disabled with a real explanation ("Cannot delete: 3 posts
// reference this horse") instead of offering a delete that is certain to fail
// with a 23503 — and it keeps the count query out of the client, where it would
// be a second round trip and a second RLS surface.
//
// The server re-checks anyway: `blockedReason` is UX, never the enforcement.
// The route counts again and maps a genuine FK violation to the same sentence,
// so a row created between the page render and the click still refuses cleanly.
export default function DangerDelete({
  endpoint,
  redirectTo,
  heading,
  description,
  confirmText,
  blockedReason,
  testId,
}: {
  /** Admin BFF URL to DELETE. Every one of these is behind requireAdmin(). */
  endpoint: string;
  /** Where to send the operator once the row is gone (the list screen). */
  redirectTo: string;
  heading: string;
  description: string;
  /** Must say, in words, that this cannot be undone. */
  confirmText: string;
  /** Non-null = refuse up front and say why. */
  blockedReason: string | null;
  testId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onDelete() {
    if (typeof window !== "undefined" && !window.confirm(confirmText)) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(endpoint, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        const json = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(json?.error?.message ?? `Delete failed (${res.status}).`);
      }
      router.replace(redirectTo);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed.");
      setBusy(false);
    }
  }

  return (
    <div
      className="adm-card"
      data-testid={testId}
      style={{ marginTop: 22, borderColor: "var(--red)" }}
    >
      <div className="adm-card-head">
        <div>
          <h2 style={{ color: "var(--red)" }}>{heading}</h2>
          <div className="sub">{description}</div>
        </div>
      </div>
      <div className="adm-card-body">
        {blockedReason ? (
          <p className="adm-help" style={{ margin: "0 0 12px", color: "var(--red)" }} role="status">
            {blockedReason}
          </p>
        ) : null}
        <button
          type="button"
          className="btn"
          data-testid={`${testId}-button`}
          disabled={busy || blockedReason !== null}
          title={blockedReason ?? undefined}
          onClick={onDelete}
          style={{
            padding: "10px 22px",
            background: "var(--white)",
            color: "var(--red)",
            border: "1px solid var(--red)",
            cursor: busy || blockedReason ? "default" : "pointer",
            opacity: busy || blockedReason ? 0.55 : 1,
          }}
        >
          {busy ? "Deleting…" : heading}
        </button>
        {error ? (
          <p className="adm-help" style={{ marginTop: 10, color: "var(--red)" }} role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
