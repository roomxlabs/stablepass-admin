// Referential-integrity refusals for the admin delete affordances.
//
// The three deletes this repo exposes are REFUSED by Postgres, never cascaded,
// on the paths that matter — every one of these FKs is `not null` with no
// ON DELETE action:
//
//   horse    <- post.horse_id            (a horse with posts cannot be deleted)
//   trainer  <- horse.trainer_id         (a trainer with horses cannot be deleted)
//   trainer  <- post.source_trainer_id   (a trainer with posts cannot be deleted)
//
// Everything else that points at these rows cascades cleanly and needs no
// handling here: trainer_contact, follow, notify_optin, race_horse,
// bookmark, reaction, impression, trainer_website_click.
//
// Which is why the working order is POSTS -> HORSES -> TRAINERS, and why every
// refusal says so. A raw `23503` tells the operator nothing; a count and an
// order tells them exactly what to delete next.

/** The one blocking relationship: how many rows, and what to call them. */
export type Blocker = { count: number; singular: string; plural: string };

/** The delete order, stated once so every message and every screen agrees. */
export const DELETE_ORDER_HINT = "Delete in this order: posts, then horses, then trainers.";

function phrase(b: Blocker): string {
  return `${b.count} ${b.count === 1 ? b.singular : b.plural}`;
}

/**
 * The refusal message for a PRE-COUNTED delete, or null when nothing blocks it.
 *
 * Pre-counting is what lets the UI disable the button with a reason instead of
 * offering a delete that is certain to fail, so this is the primary path; the
 * FK backstop below only exists for the race between the count and the delete.
 */
export function blockedMessage(subject: string, blockers: Blocker[]): string | null {
  const hits = blockers.filter((b) => b.count > 0);
  if (hits.length === 0) return null;
  const parts = hits.map(phrase);
  const list =
    parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Cannot delete: ${list} reference this ${subject}. ${DELETE_ORDER_HINT}`;
}

/**
 * Postgres `foreign_key_violation`. PostgREST forwards the SQLSTATE verbatim as
 * `error.code`, so this is a stable discriminator — unlike matching the message.
 */
export function isForeignKeyViolation(error: { code?: string | null } | null | undefined): boolean {
  return error?.code === "23503";
}

/**
 * Backstop message for an FK violation we did NOT pre-count — i.e. a row that
 * was created between the count and the delete. No counts are available by
 * then (the statement already failed), so it names the order instead of a
 * number rather than reporting a count we would have to re-read to trust.
 */
export function foreignKeyMessage(subject: string): string {
  return `Cannot delete: something still references this ${subject}. ${DELETE_ORDER_HINT}`;
}
