"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { PostStatus } from "./types";
import { discardDraft, publishNow, republishPost, unpublishPost } from "./api";

// The per-row action affordances. Which action shows is a pure function of the
// post's status (guardrail §2): Discard appears only on a draft; a published
// post can be Unpublished (reversible soft-hide) and an unpublished one
// Republished; a scheduled post can be Published now. Edit always links to
// Compose (T6), where the editable fields are PATCHed via T5.
export default function PostActions({
  id,
  status,
  editHref,
}: {
  id: string;
  status: PostStatus;
  editHref: string;
}) {
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
      <Link href={editHref}>Edit</Link>
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
      {status === "scheduled" && (
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
      {error && (
        <span className="row-err" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
