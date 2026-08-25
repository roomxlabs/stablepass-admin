import { describe, it, expect } from "vitest";
import { blockedMessage, foreignKeyMessage, isForeignKeyViolation } from "./references";

describe("blockedMessage", () => {
  it("returns null when nothing blocks the delete", () => {
    expect(blockedMessage("horse", [{ count: 0, singular: "post", plural: "posts" }])).toBeNull();
  });

  it("counts, and singularises exactly one", () => {
    expect(blockedMessage("horse", [{ count: 1, singular: "post", plural: "posts" }])).toBe(
      "Cannot delete: 1 post reference this horse. Delete in this order: posts, then horses, then trainers.",
    );
  });

  it("names the count the operator has to clear", () => {
    expect(blockedMessage("horse", [{ count: 3, singular: "post", plural: "posts" }])).toContain(
      "Cannot delete: 3 posts reference this horse",
    );
  });

  it("joins two blockers so the second is not a surprise after clearing the first", () => {
    expect(
      blockedMessage("trainer", [
        { count: 4, singular: "post", plural: "posts" },
        { count: 2, singular: "horse", plural: "horses" },
      ]),
    ).toContain("4 posts and 2 horses reference this trainer");
  });

  it("drops a zero blocker from a mixed set", () => {
    const msg = blockedMessage("trainer", [
      { count: 0, singular: "post", plural: "posts" },
      { count: 2, singular: "horse", plural: "horses" },
    ]);
    expect(msg).toContain("2 horses reference this trainer");
    // "posts" still appears in the trailing order hint, so assert on the
    // COUNT phrase — that is what must not be there for a zero blocker.
    expect(msg).not.toContain("0 post");
  });
});

describe("isForeignKeyViolation", () => {
  it("matches 23503 and nothing else", () => {
    expect(isForeignKeyViolation({ code: "23503" })).toBe(true);
    expect(isForeignKeyViolation({ code: "23505" })).toBe(false);
    expect(isForeignKeyViolation(null)).toBe(false);
    expect(isForeignKeyViolation(undefined)).toBe(false);
  });
});

describe("foreignKeyMessage", () => {
  it("never leaks the SQLSTATE and always states the order", () => {
    const msg = foreignKeyMessage("horse");
    expect(msg).not.toContain("23503");
    expect(msg).toContain("posts, then horses, then trainers");
  });
});
