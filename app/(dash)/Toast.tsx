"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// One toast primitive for the whole dashboard (ENG-964).
//
// Before this, a row action that succeeded said nothing at all and a row action
// that failed rendered an 11px `.row-err` string wedged into the actions cell —
// easy to miss, and invisible to a screen reader unless focus happened to be
// nearby. Both now go through here.
//
// ACCESSIBILITY is the reason this is a primitive rather than a `<span>`: the
// toasts render into TWO permanently-mounted live regions, not into one region
// that appears with the message. A live region only announces mutations that
// happen while it is already in the DOM, so a region that mounts together with
// its first message is silent — the classic aria-live bug. Success goes to the
// polite region (it must not interrupt whatever the operator is reading);
// failure goes to the assertive one, because a publish that did not happen is
// exactly the thing the operator must not walk away believing.
//
// Both regions live inside ONE `position: fixed` stack, so a caller can mount
// `<ToastRegion/>` anywhere — including inside a `<td>` in the posts table —
// without the markup position affecting where the toast appears, and so a
// success and a failure alive at the same time stack instead of overlapping.

export type ToastTone = "success" | "error";

export type ToastMessage = {
  id: number;
  text: string;
  tone: ToastTone;
};

/** Success auto-dismisses; a failure stays roughly twice as long to be read. */
export const SUCCESS_TTL_MS = 4000;
export const ERROR_TTL_MS = 8000;

/**
 * How long a form that navigates away on save holds the screen so its success
 * toast is actually seen (the horse + trainer forms `router.push` back to their
 * list). Long enough to read four words; short enough that it reads as the
 * transition, not a hang.
 *
 * Read through `saveToastHoldMs()`, never inlined, because it is a REAL timer:
 * at 900ms it left ~40ms of headroom under the 1000ms default `waitFor` timeout
 * that TrainerForm's 17 pre-existing navigation assertions use — green on an
 * idle machine, a flake waiting to happen on a loaded one, and it added ~13s of
 * dead wall-clock to the suite. Tests call `setSaveToastHoldMs(0)` instead of
 * each one raising its own timeout.
 */
export const SAVE_TOAST_HOLD_MS = 900;

let saveHoldMs = SAVE_TOAST_HOLD_MS;
/** The hold in force right now. */
export const saveToastHoldMs = (): number => saveHoldMs;
/** Test seam — set to 0 so a save navigates without burning real time. */
export function setSaveToastHoldMs(ms: number): void {
  saveHoldMs = ms;
}

let nextId = 0;

export type ToastApi = {
  toasts: ToastMessage[];
  /** Show a toast. Returns its id so a caller can dismiss it early. */
  showToast: (text: string, tone?: ToastTone) => number;
  dismissToast: (id: number) => void;
};

/**
 * Toast state for one screen. Every timer is tracked and cleared on unmount, so
 * a component that navigates away mid-action (the horse/trainer forms
 * `router.push` on save) never fires a `setState` on an unmounted tree.
 */
export function useToast(): ToastApi {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    },
    [],
  );

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (text: string, tone: ToastTone = "success") => {
      const id = ++nextId;
      setToasts((prev) => [...prev, { id, text, tone }]);
      const ttl = tone === "error" ? ERROR_TTL_MS : SUCCESS_TTL_MS;
      timers.current.push(
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== id));
        }, ttl),
      );
      return id;
    },
    [],
  );

  return { toasts, showToast, dismissToast };
}

function ToastItem({ toast, onDismiss }: { toast: ToastMessage; onDismiss: (id: number) => void }) {
  return (
    <div className={`adm-toast ${toast.tone}`} data-testid="adm-toast">
      <span className="adm-toast-text">{toast.text}</span>
      <button
        type="button"
        className="adm-toast-x"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
      >
        ×
      </button>
    </div>
  );
}

/**
 * The two live regions. Mount this ONCE per screen, unconditionally — the
 * regions must already exist before a message lands in them (see the note at
 * the top of this file), which is why neither region is conditionally rendered.
 *
 * The regions carry `aria-live` but deliberately NOT `role="status"` /
 * `role="alert"`. Those roles are only implicit `aria-live` values, so they add
 * nothing to the announcement — but because the regions are always mounted,
 * even when empty, tagging them with a role puts a permanent EMPTY alert on
 * every screen that mounts a toast. That is not hypothetical: it broke nine
 * TrainerForm tests, which read the form's error banner via `getByRole("alert")`
 * and matched the empty toast region instead (returning ""). A screen's own
 * `role="alert"` banner must stay the only alert on the page.
 */
export default function ToastRegion({ toasts, onDismiss }: { toasts: ToastMessage[]; onDismiss: (id: number) => void }) {
  const polite = toasts.filter((t) => t.tone !== "error");
  const assertive = toasts.filter((t) => t.tone === "error");

  return (
    // One fixed stack, two live regions inside it. Previously the two regions
    // were each `position: fixed` at the same coordinates, so a success and a
    // failure alive at the same time rendered on top of one another.
    <div className="adm-toast-stack">
      <div className="adm-toast-region" aria-live="polite" aria-atomic="false">
        {polite.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
        ))}
      </div>
      <div className="adm-toast-region assertive" aria-live="assertive" aria-atomic="false">
        {assertive.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
        ))}
      </div>
    </div>
  );
}
