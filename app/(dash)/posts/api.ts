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
