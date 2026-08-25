"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PostStatus } from "./types";
import { deletePost, discardDraft, publishNow, republishPost, unpublishPost } from "./api";

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
export default function PostActions({ id, status }: { id: string; status: PostStatus }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const working = busy || pending;

  async function act(fn: (id: string) => Promise<void>, confirm?: string) {
    if (confirm && typeof window !== "undefined" && !window.confirm(confirm)) return;
    setError(null);
    setBusy(true);
    try {
      await fn(id);
      // Re-run the server component so the row reflects its new status.
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {status === "published" && (
        <button type="button" className="danger" disabled={working} onClick={() => act(unpublishPost)}>
          Unpublish
        </button>
      )}
      {status === "unpublished" && (
        <button type="button" disabled={working} onClick={() => act(republishPost)}>
          Republish
        </button>
      )}
      {(status === "scheduled" || status === "draft") && (
        <button type="button" disabled={working} onClick={() => act(publishNow)}>
          Publish now
        </button>
      )}
      {status === "draft" && (
        <button
          type="button"
          className="danger"
          disabled={working}
          onClick={() => act(discardDraft, "Discard this draft? This can't be undone.")}
        >
          Discard
        </button>
      )}
      {status !== "draft" && (
        <button
          type="button"
          className="destructive"
          disabled={working}
          title="Permanently delete this post"
          onClick={() => act(deletePost, DELETE_CONFIRM)}
        >
          Delete
        </button>
      )}
      {error && (
        <span className="row-err" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
