"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PostStatus } from "./types";
import { deletePost, discardDraft, publishNow, republishPost, unpublishPost } from "./api";
import ToastRegion, { useToast } from "../Toast";

// The per-row action affordances. Which action shows is a pure function of the
// post's status (guardrail §2): Discard appears only on a draft; a published
// post can be Unpublished (reversible soft-hide) and an unpublished one
// Republished; a scheduled or draft post can be Published now (the publish
// endpoint accepts both). Opening the post detail (Compose in edit mode) is
// the row click itself (PostRow), not an action here.
//
// DELETE is the one addition, and it is NOT a second unpublish. Unpublish stays
// exactly as it was — the reversible soft hide §2 requires — and Delete removes
// the row. They are kept apart three ways so no operator can confuse them: a
// different word, a different treatment (a bordered red chip, not red text),
// and a confirmation that says in full sentences that it cannot be undone.
//
// It shows on every status EXCEPT draft, where Discard already is this action
// under §2's own name; showing both there would be two buttons doing one thing.
const DELETE_CONFIRM =
  "Permanently delete this post?\n\n" +
  "This removes the post from the database. It CANNOT be undone.\n\n" +
  "To hide a published post from members without deleting it, cancel and use Unpublish instead.";
// What each action says when it succeeds, and the status the row optimistically
// takes while `router.refresh()` re-runs the server component. `null` means the
// row is going away (discard / delete) — there is no next status to show, so
// the affordances are simply retired.
//
// The optimistic status is deliberately LOCAL to this component rather than
// hoisted into the posts list: PostsLibrary.tsx / PostRow.tsx are outside this
// ticket's surface and are being edited concurrently by ENG-963. The row's
// pills still update on refresh as they always did; what this fixes is the ~1s
// window where the operator had already clicked "Unpublish" and the button
// still said "Unpublish", which is what made people click it twice.
const OUTCOME: Record<string, { message: string; next: PostStatus | null }> = {
  unpublish: { message: "Post unpublished — members can no longer see it.", next: "unpublished" },
  republish: { message: "Post republished — it's live for members again.", next: "published" },
  publish: { message: "Post published.", next: "published" },
  discard: { message: "Draft discarded.", next: null },
  delete: { message: "Post permanently deleted.", next: null },
};

export default function PostActions({ id, status }: { id: string; status: PostStatus }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  // Optimistic overlay on the server-rendered `status`. `undefined` = no action
  // has completed yet, so the server's value stands; `null` = the row is gone.
  const [optimistic, setOptimistic] = useState<PostStatus | null | undefined>(undefined);
  const { toasts, showToast, dismissToast } = useToast();
  const working = busy || pending;
  // Drop the overlay as soon as the SERVER sends a different status than the
  // one it was standing in for. Without this the overlay shadows the prop for
  // the life of the component: a row re-rendered with a genuinely new status —
  // someone else republishes while this instance is still mounted — would keep
  // showing the stale affordance forever.
  const [seenStatus, setSeenStatus] = useState<PostStatus>(status);
  if (status !== seenStatus) {
    setSeenStatus(status);
    setOptimistic(undefined);
  }
  const shown = optimistic === undefined ? status : optimistic;

  async function act(fn: (id: string) => Promise<void>, key: keyof typeof OUTCOME, confirm?: string) {
    if (confirm && typeof window !== "undefined" && !window.confirm(confirm)) return;
    setBusy(true);
    try {
      await fn(id);
      // Only adopt the optimistic status AFTER the BFF confirmed the
      // transition. Flipping it before the await would show "Unpublished" for a
      // call that then 409s — the publish routes re-assert the precondition on
      // the UPDATE itself (see ENG-950), so losing a race is a real outcome.
      setOptimistic(OUTCOME[key].next);
      showToast(OUTCOME[key].message, "success");
      // Re-run the server component so the row reflects its new status.
      startTransition(() => router.refresh());
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Action failed.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {shown === "published" && (
        <button type="button" className="danger" disabled={working} onClick={() => act(unpublishPost, "unpublish")}>
          Unpublish
        </button>
      )}
      {shown === "unpublished" && (
        <button type="button" disabled={working} onClick={() => act(republishPost, "republish")}>
          Republish
        </button>
      )}
      {(shown === "scheduled" || shown === "draft") && (
        <button type="button" disabled={working} onClick={() => act(publishNow, "publish")}>
          Publish now
        </button>
      )}
      {shown === "draft" && (
        <button
          type="button"
          className="danger"
          disabled={working}
          onClick={() => act(discardDraft, "discard", "Discard this draft? This can't be undone.")}
        >
          Discard
        </button>
      )}
      {shown !== null && shown !== "draft" && (
        <button
          type="button"
          className="destructive"
          disabled={working}
          title="Permanently delete this post"
          onClick={() => act(deletePost, "delete", DELETE_CONFIRM)}
        >
          Delete
        </button>
      )}
      {/* Replaces the old 11px `.row-err` string in the actions cell: a failed
          publish now announces itself assertively instead of hiding in the
          corner of a table row (ENG-964). */}
      <ToastRegion toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
