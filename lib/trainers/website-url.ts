// trainer.website_url — the one place the "what counts as a website" rule lives.
//
// ENG-746. The column has existed since 20260719120000_analytics.sql:45 but was
// un-settable from anywhere in the product: no admin form and no admin route
// ever wrote it. This module is shared by the admin form (client) and BOTH
// trainer routes (server) so the three can never disagree about what is
// acceptable — a client that accepted more than the server would produce a
// mystery 400, and a server that accepted more than the member web app renders
// would silently store a link that never appears.
//
// The rule deliberately MIRRORS stablepass-web's `safeHref`
// (`app/(member)/trainers/[id]/website-link.tsx`), which is the only consumer:
//
//   * parse with `new URL()`, and
//   * accept ONLY the `http:` / `https:` protocols.
//
// Two consequences of mirroring it exactly, both intended:
//
//   * A bare domain ("wallerracing.com.au") is REJECTED. It is not a parseable
//     absolute URL, so web renders no link at all for it. Accepting it here
//     would store a value that looks saved and is permanently invisible.
//   * `javascript:` (and `data:`, `file:`, …) parse fine but are refused on the
//     protocol check — the same check web relies on, applied a layer earlier so
//     the value never reaches the database.
//
// We return the caller's TRIMMED ORIGINAL rather than `url.href`, for the same
// reason web does: `new URL()` normalises, and normalisation rewrites what the
// admin typed (most visibly by appending a trailing slash to a bare origin).
// Round-tripping the admin's own text is worth more than canonical form.

/** The website field's parsed outcome. `value: null` means "no website set". */
export type WebsiteUrlResult =
  | { ok: true; value: string | null }
  | { ok: false; message: string };

/** The message shown by the form and returned by both routes on a 400. */
export const WEBSITE_URL_MESSAGE =
  "Website must be a full web address starting with http:// or https:// (for example https://wallerracing.com.au).";

/**
 * Parse a website value from a form field or a request body.
 *
 * Accepts `null` / `undefined` / `""` / whitespace as "no website" (→ `null`),
 * so clearing the field saves as NULL rather than an empty string. Anything
 * else must be an absolute http(s) URL.
 */
export function parseWebsiteUrl(raw: unknown): WebsiteUrlResult {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  // A non-string (a number, an object) is a malformed body, not an empty field.
  if (typeof raw !== "string") return { ok: false, message: WEBSITE_URL_MESSAGE };

  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };

  let protocol: string;
  try {
    ({ protocol } = new URL(trimmed));
  } catch {
    return { ok: false, message: WEBSITE_URL_MESSAGE };
  }
  if (protocol !== "http:" && protocol !== "https:")
    return { ok: false, message: WEBSITE_URL_MESSAGE };

  return { ok: true, value: trimmed };
}
