import { describe, expect, it } from "vitest";
import { isUuid, uuidParam } from "./uuid";

// The regression this file exists for: the previous guard was
// `/^[0-9a-f-]{36}$/i`, which matches any 36-char run of hex-or-dash. The
// all-dashes case below passed it, reached Postgres, and came back as
// `invalid input syntax for type uuid` — echoed to the client by
// `fail("query_failed", error.message)` on the route and rendered as a 500
// page by the Posts screen.
const ALL_DASHES = "-".repeat(36);

describe("isUuid", () => {
  it("rejects 36 dashes — the value the old /^[0-9a-f-]{36}$/i guard let through", () => {
    expect(ALL_DASHES).toHaveLength(36);
    // Proves the OLD regex was the bug, not a hypothetical: it accepts this.
    expect(/^[0-9a-f-]{36}$/i.test(ALL_DASHES)).toBe(true);
    expect(isUuid(ALL_DASHES)).toBe(false);
  });

  it("accepts a real uuid in either case", () => {
    expect(isUuid("9f1c7a2e-4b3d-4c8a-9e17-2f5b6c0d8a41")).toBe(true);
    expect(isUuid("9F1C7A2E-4B3D-4C8A-9E17-2F5B6C0D8A41")).toBe(true);
  });

  it.each([
    ["hex with no dashes (32)", "9f1c7a2e4b3d4c8a9e172f5b6c0d8a41"],
    ["hex run padded to 36 chars", "9f1c7a2e4b3d4c8a9e172f5b6c0d8a41----"],
    ["dashes in the wrong places", "9f1c7a2e4-b3d-4c8a-9e17-2f5b6c0d8a4"],
    ["a non-hex letter", "9f1c7a2z-4b3d-4c8a-9e17-2f5b6c0d8a41"],
    ["one char short", "9f1c7a2e-4b3d-4c8a-9e17-2f5b6c0d8a4"],
    ["one char long", "9f1c7a2e-4b3d-4c8a-9e17-2f5b6c0d8a411"],
    ["a seed id from the e2e fixtures", "t1"],
    ["empty", ""],
    ["a PostgREST injection attempt", "1,id.gt.0"],
  ])("rejects %s", (_label, value) => {
    expect(isUuid(value)).toBe(false);
  });

  it("rejects non-strings without throwing", () => {
    for (const v of [undefined, null, 42, {}, [], ["9f1c7a2e-4b3d-4c8a-9e17-2f5b6c0d8a41"]])
      expect(isUuid(v)).toBe(false);
  });
});

describe("uuidParam", () => {
  it("passes a uuid through and blanks everything else", () => {
    expect(uuidParam("9f1c7a2e-4b3d-4c8a-9e17-2f5b6c0d8a41")).toBe(
      "9f1c7a2e-4b3d-4c8a-9e17-2f5b6c0d8a41",
    );
    expect(uuidParam(ALL_DASHES)).toBe("");
    expect(uuidParam(undefined)).toBe("");
    expect(uuidParam(["a"])).toBe("");
  });
});
