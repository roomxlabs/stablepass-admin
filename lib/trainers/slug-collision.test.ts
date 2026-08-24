import { describe, expect, it } from "vitest";
import { slugCollisionMessage } from "./slug-collision";

// This message is the entire user-visible deliverable of ENG-746 item 1, so the
// wording is pinned against LITERAL expected phrases rather than against the
// module's own constant. Asserting `msg === slugCollisionMessage(...)` would be
// vacuous: the implementation and the expectation would be the same source of
// truth, and the copy could be changed to anything at all while staying green.

describe("slugCollisionMessage", () => {
  const msg = slugCollisionMessage("chris-waller");

  it("shows the value that actually collided", () => {
    expect(msg).toContain("chris-waller");
  });

  it("names the cause in the admin's terms, not the database's", () => {
    expect(msg).toContain("unique ID");
    // "slug" is engineering vocabulary and means nothing to the person blocked.
    expect(msg).not.toContain("slug");
  });

  it("does not claim the slug is a URL, because nothing in the product uses it as one", () => {
    // Guarded because an earlier draft of this ticket DID claim it, showing the
    // admin a "/chris-waller" page that does not exist anywhere in web, admin or
    // mobile. On a ticket about telling the truth that is the worst kind of bug.
    expect(msg).not.toMatch(/web address/i);
    expect(msg).not.toMatch(/\bURL\b/i);
    expect(msg).not.toContain("/chris-waller");
  });

  it("does not assert the two names match, because they need not", () => {
    expect(msg).toMatch(/even when the names look slightly different/i);
  });

  it("offers both remedies, duplicate-safe one FIRST", () => {
    const openExisting = msg.indexOf("Open that trainer from the Trainers list");
    const rename = msg.indexOf("change the full name slightly");
    expect(openExisting).toBeGreaterThan(-1);
    expect(rename).toBeGreaterThan(-1);
    // Load-bearing, not cosmetic (ENG-766): this 409 is also reachable when the
    // trainer WAS created and the response was lost. Leading with "rename" there
    // turns one lost response into two live trainers.
    expect(openExisting).toBeLessThan(rename);
  });

  it("interpolates whatever slug it is given", () => {
    expect(slugCollisionMessage("peter-moody")).toContain("peter-moody");
    expect(slugCollisionMessage("peter-moody")).not.toContain("chris-waller");
  });
});
