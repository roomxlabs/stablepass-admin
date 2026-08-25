// Client network layer for the Posts library row actions. Every call hits one
// of T5's admin-gated post endpoints (`requireAdmin` server-side) — this screen
// never mutates a post directly. Discard is draft-only + a hard delete;
// unpublish is a reversible soft-hide (guardrail §2), both enforced by the BFF,
// so a non-draft discard 409s and surfaces as a thrown Error here.

async function call(url: string, method: "POST" | "DELETE", action: string): Promise<void> {
  const res = await fetch(url, { method });
  if (res.ok || res.status === 204) return;
  const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  throw new Error(json?.error?.message ?? `${action} failed (${res.status}).`);
}

/** Reversible soft-hide of a published post. POST /api/admin/posts/:id/unpublish */
export const unpublishPost = (id: string): Promise<void> =>
  call(`/api/admin/posts/${id}/unpublish`, "POST", "Unpublish");

/** Return an unpublished post to published. POST /api/admin/posts/:id/republish */
export const republishPost = (id: string): Promise<void> =>
  call(`/api/admin/posts/${id}/republish`, "POST", "Republish");

/** Publish a scheduled/draft post now. POST /api/admin/posts/:id/publish */
export const publishNow = (id: string): Promise<void> =>
  call(`/api/admin/posts/${id}/publish`, "POST", "Publish");

/** Discard a DRAFT (hard delete, draft-only per guardrail §2). DELETE → 204 */
export const discardDraft = (id: string): Promise<void> =>
  call(`/api/admin/posts/${id}`, "DELETE", "Discard");

/**
 * HARD delete a post of ANY status — the operator data-cleanup path, and a
 * DELIBERATE SCOPED EXCEPTION to guardrail §2 (see the route's own note).
 *
 * A SEPARATE URL from `discardDraft` on purpose: `DELETE /api/admin/posts/:id`
 * stays draft-only and still 409s a published post, so §2's test is untouched
 * and nothing about `unpublish` changes. This is not "unpublish, harder" — it
 * removes the row, and the confirmation says so.
 *
 * DELETE /api/admin/posts/:id/delete → 204
 */
export const deletePost = (id: string): Promise<void> =>
  call(`/api/admin/posts/${id}/delete`, "DELETE", "Delete");

/** Response from POST /api/admin/posts/:id/poster (ENG-825). */
export type PosterRebakeResult = {
  posterUrl: string;
  posterTimeS: number;
  posterDisplayUrl: string | null;
};

/**
 * Re-bake the video poster at `time` seconds. POSTs `{ time }` to the BFF,
 * which invokes BE `rebake-poster` with the admin session (no Mux/service-role
 * material client-side). On failure the previous poster_url is unchanged.
 */
export async function rebakePoster(id: string, time: number): Promise<PosterRebakeResult> {
  const res = await fetch(`/api/admin/posts/${id}/poster`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ time }),
  });
  const json = (await res.json().catch(() => null)) as {
    data?: PosterRebakeResult;
    error?: { message?: string };
  } | null;
  if (!res.ok || !json?.data) {
    throw new Error(json?.error?.message ?? `Poster re-bake failed (${res.status}).`);
  }
  return json.data;
}
