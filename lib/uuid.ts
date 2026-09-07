// One shared uuid shape-check, so the `?trainerId=` guard means the same thing
// on the Posts screen, the Horses screen and the BFF list route.
//
// It replaces `/^[0-9a-f-]{36}$/i`, which was NOT a uuid check: it accepts any
// 36-character run of hex digits and dashes, so a string of 36 dashes passed it
// and reached Postgres. There it 400s with
// `invalid input syntax for type uuid: "---…"`, which the route then echoed
// back through `fail("query_failed", error.message)` and the screen turned into
// a 500 error page — the exact schema-detail leak the comments at the call
// sites claim the check prevents, and the opposite of their "a bad bookmark
// shows the library" promise.
//
// Deliberately shape-only and version-agnostic (8-4-4-4-12 hex): the point is
// to keep a malformed value out of the query, not to police uuid versions.
// Pinned by lib/uuid.test.ts, including the all-dashes case.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True only for a well-formed 8-4-4-4-12 hex uuid. */
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** The value if it is a uuid, else "" — the "ignore a stale link" form. */
export function uuidParam(v: unknown): string {
  return isUuid(v) ? v : "";
}
