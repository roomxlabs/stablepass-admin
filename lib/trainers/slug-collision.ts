// The create-trainer 409 message (ENG-746, Mel's block).
//
// Extracted from TrainerForm so the exact wording can be pinned by a test, and
// so the form is not carrying a 300-character template literal in the middle of
// a file two tickets are editing at once (ENG-749 owns it next).
//
// WHAT THE 409 ACTUALLY MEANS, and how that is known:
//
//   * `slug` is the ONLY unique constraint on `trainer`
//     (stablepass-be 20260704120001_schema.sql; asserted against the real
//     migration text by app/api/admin/trainers/slug-unique-drift.test.ts, so
//     this stops being true loudly rather than silently).
//   * `POST /api/admin/trainers` maps only Postgres 23505 to a 409, and the
//     insert supplies no id, so the primary key cannot be the collision.
//   * The admin form derives the slug from Full name via `slugify`.
//
// Therefore: a 409 on create is always a slug collision, and the slug always
// came from the name that was typed.
//
// WHAT IT IS NOT. An earlier draft of this copy called the slug the trainer's
// "profile web address" and showed it as `/chris-waller`. That was false, and on
// a ticket about telling the truth it was the wrong kind of false: nothing in
// web, admin or mobile ever reads `trainer.slug`, and the member profile
// resolves by id (`/trainers/<uuid>`), so `/chris-waller` is a page that does
// not exist. An admin could disprove it in five seconds by looking at the URL
// bar, which would cost them their trust in every other message we show. The
// slug is an internal unique identifier, so that is what this says.

/**
 * The message shown when creating a trainer returns the slug-collision 409.
 *
 * @param slug the slug that collided, already derived from the typed name.
 *
 * The order of the two remedies is deliberate and load-bearing, not stylistic
 * (it preserves ENG-766's reasoning). This 409 is also reachable when the
 * trainer WAS created and the response was lost, and in that state advising a
 * rename is exactly what turns one lost response into two live trainers. So
 * "open the existing one" comes first, and renaming is offered second for the
 * genuinely-different-trainer case.
 *
 * It also avoids claiming the two NAMES match. The collision is on the derived
 * slug, so "Chris Waller", "chris waller" and "Chris  Waller!" all collide while
 * looking different - which is very likely what actually happened to Mel.
 */
export function slugCollisionMessage(slug: string): string {
  return (
    `A trainer with this name already exists. The name is turned into that trainer's ` +
    `unique ID (${slug}), so two trainers cannot share one even when the names look ` +
    `slightly different. Open that trainer from the Trainers list; it may be the one ` +
    `you are adding. If it is genuinely a different trainer, change the full name slightly.`
  );
}
