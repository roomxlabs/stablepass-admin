"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

// One toast primitive for the whole dashboard (ENG-964).
//
// Before this, a row action that succeeded said nothing at all and a row action
// that failed rendered an 11px `.row-err` string wedged into the actions cell —
// easy to miss, and invisible to a screen reader unless focus happened to be
// nearby. Both now go through here.
//
// ACCESSIBILITY is the reason this is a primitive rather than a `<span>`, and
// it drives two structural decisions:
//
// 1. The toasts render into TWO permanently-mounted live regions, not into one
//    region that appears with the message. A live region only announces
//    mutations that happen while it is already in the DOM AND already in the
//    accessibility tree, so a region that mounts together with its first
//    message is silent — the classic aria-live bug. (`display: none` counts as
//    "not in the tree": see the CSS contract in Toast.test.tsx, which forbids
//    any rule that hides `.adm-toast-region`.) Success goes to the polite
//    region (it must not interrupt whatever the operator is reading); failure
//    goes to the assertive one, because a publish that did not happen is
//    exactly the thing the operator must not walk away believing.
//
// 2. There is exactly ONE region pair per page, and the toast queue lives in a
//    MODULE-level store rather than in component state. The first cut kept the
//    queue in `useToast()` and rendered `<ToastRegion/>` from `PostActions`,
//    which is per row: a 20-row posts page mounted 40 live regions and 20 fixed
//    stacks at the same coordinates, so two toasts raised from two different
//    rows — unpublish one row, publish another that 409s, the exact repro this
//    feature exists for — still painted on top of each other. A global store
//    means any caller anywhere can raise a toast into the one region.
//
// `ToastRegion` is mounted once, in `app/(dash)/layout.tsx`, so it never
// unmounts as the operator moves between dashboard routes. It additionally
// elects a single owner (below), so a stray second mount renders nothing rather
// than duplicating the live regions.

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

// ---------------------------------------------------------------------------
// The store. One queue for the whole app.
// ---------------------------------------------------------------------------

let nextId = 0;
let queue: ToastMessage[] = [];
const queueListeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emitQueue(): void {
  queueListeners.forEach((l) => l());
}

function subscribeQueue(listener: () => void): () => void {
  queueListeners.add(listener);
  return () => {
    queueListeners.delete(listener);
  };
}

const readQueue = (): ToastMessage[] => queue;

/**
 * Show a toast. Returns its id so a caller can dismiss it early.
 *
 * Safe to call from a component that is about to unmount (the horse/trainer
 * forms `router.push` on save): the queue is module state, so the auto-dismiss
 * timer never touches an unmounted tree.
 */
export function showToast(text: string, tone: ToastTone = "success"): number {
  const id = ++nextId;
  queue = [...queue, { id, text, tone }];
  emitQueue();
  const ttl = tone === "error" ? ERROR_TTL_MS : SUCCESS_TTL_MS;
  timers.set(
    id,
    setTimeout(() => {
      dismissToast(id);
    }, ttl),
  );
  return id;
}

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  if (!queue.some((t) => t.id === id)) return;
  queue = queue.filter((t) => t.id !== id);
  emitQueue();
}

/** Test seam — drop every queued toast and its pending timer between tests. */
export function resetToastsForTest(): void {
  timers.forEach(clearTimeout);
  timers.clear();
  queue = [];
  emitQueue();
}

export type ToastApi = {
  toasts: ToastMessage[];
  showToast: (text: string, tone?: ToastTone) => number;
  dismissToast: (id: number) => void;
};

/**
 * Subscribe a component to the shared queue. Callers that only RAISE toasts can
 * import `showToast` directly; this hook exists for the region and for tests.
 */
export function useToast(): ToastApi {
  const toasts = useSyncExternalStore(subscribeQueue, readQueue, readQueue);
  return { toasts, showToast, dismissToast };
}

// ---------------------------------------------------------------------------
// Single-owner election, so a second <ToastRegion/> is inert rather than a
// duplicate live region.
// ---------------------------------------------------------------------------

let regionSeq = 0;
let ownerId: number | null = null;
const waiting: number[] = [];
const ownerListeners = new Set<() => void>();

function claimRegion(id: number): void {
  if (ownerId === null) {
    ownerId = id;
  } else if (ownerId !== id && !waiting.includes(id)) {
    waiting.push(id);
  }
  ownerListeners.forEach((l) => l());
}

function releaseRegion(id: number): void {
  const w = waiting.indexOf(id);
  if (w >= 0) waiting.splice(w, 1);
  if (ownerId === id) ownerId = waiting.shift() ?? null;
  ownerListeners.forEach((l) => l());
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
 * The two live regions. Mounted ONCE, from the `(dash)` layout, unconditionally
 * — the regions must already exist, and be visible to assistive tech, before a
 * message lands in them (see the note at the top of this file).
 *
 * The regions carry `aria-live` but deliberately NOT `role="status"` /
 * `role="alert"`. Those roles are only implicit `aria-live` values, so they add
 * nothing to the announcement — but because the regions are always mounted,
 * even when empty, tagging them with a role puts a permanent EMPTY alert on
 * every screen. That is not hypothetical: it broke nine TrainerForm tests,
 * which read the form's error banner via `getByRole("alert")` and matched the
 * empty toast region instead (returning ""). A screen's own `role="alert"`
 * banner must stay the only alert on the page.
 */
export default function ToastRegion() {
  // A stable per-instance id, taken once on first render (lazy initialiser),
  // so ownership survives every re-render of this component.
  const [id] = useState(() => ++regionSeq);
  const [owner, setOwner] = useState<number | null>(null);
  const { toasts, dismissToast: dismiss } = useToast();

  useEffect(() => {
    const sync = () => setOwner(ownerId);
    ownerListeners.add(sync);
    claimRegion(id);
    sync();
    return () => {
      ownerListeners.delete(sync);
      releaseRegion(id);
    };
  }, [id]);

  if (owner !== id) return null;

  const polite = toasts.filter((t) => t.tone !== "error");
  const assertive = toasts.filter((t) => t.tone === "error");

  return (
    // One fixed stack, two live regions inside it. Previously the two regions
    // were each `position: fixed` at the same coordinates, so a success and a
    // failure alive at the same time rendered on top of one another.
    <div className="adm-toast-stack">
      <div className="adm-toast-region" aria-live="polite" aria-atomic="false">
        {polite.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
      <div className="adm-toast-region assertive" aria-live="assertive" aria-atomic="false">
        {assertive.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </div>
  );
}
