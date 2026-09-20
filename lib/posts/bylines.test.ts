// Unit tests for `lib/posts/bylines.ts` (ENG-1267).
//
// The fold/duplicate/banned-name rules are imported wrappers over
// `lib/posts/labels.ts`'s helpers, so these mirror `labels.test.ts`'s cases
// rather than re-deriving the regex — the point is to prove the WRAPPER, not
// re-litigate the underlying rule.
import { describe, expect, it } from "vitest";
import {
  MAX_BYLINE_LENGTH,
  BYLINE_FIELDS,
  foldBylineName,
  bylineDuplicateKey,
  isBannedByline,
  orderBylines,
  toBylineDto,
  isRetired,
  type BylineRow,
} from "./bylines";

describe("foldBylineName", () => {
  it("collapses surrounding and inner whitespace", () => {
    expect(foldBylineName("  Owner   Update ")).toBe("Owner Update");
  });

  it("NFKC-normalises a fullwidth spelling", () => {
    expect(foldBylineName("Ｔrackwork")).toBe("Trackwork");
  });

  it("strips invisible characters, so a zero-width twin folds to the plain spelling", () => {
    expect(foldBylineName("Track​work")).toBe("Trackwork");
    expect(foldBylineName("Race­Day")).toBe("RaceDay");
  });

  it("preserves the canonical casing it was given", () => {
    expect(foldBylineName("stablepass editorial")).toBe("stablepass editorial");
  });
});

describe("bylineDuplicateKey", () => {
  it("is case-insensitive", () => {
    expect(bylineDuplicateKey("StablePass Editorial")).toBe(bylineDuplicateKey("stablepass editorial"));
  });

  it("collapses inner whitespace as part of the key", () => {
    expect(bylineDuplicateKey("Race  Day")).toBe(bylineDuplicateKey("Race Day"));
  });

  it("keeps genuinely different names apart", () => {
    expect(bylineDuplicateKey("Trackwork Desk")).not.toBe(bylineDuplicateKey("Trackwork"));
  });
});

describe("isBannedByline", () => {
  it.each(["Betting Desk", "Odds Room"])("is true for a gambling-flavoured name (%s)", (name) => {
    expect(isBannedByline(name)).toBe(true);
  });

  it.each(["StablePass Editorial", "Trackwork Desk"])(
    "is false for ordinary editorial vocabulary (%s)",
    (name) => {
      expect(isBannedByline(name)).toBe(false);
    },
  );
});

describe("orderBylines", () => {
  it("sorts by sort_order first", () => {
    const rows = [
      { name: "Zebra", sort_order: 2 },
      { name: "Alpha", sort_order: 0 },
      { name: "Mid", sort_order: 1 },
    ];
    expect(orderBylines(rows).map((r) => r.name)).toEqual(["Alpha", "Mid", "Zebra"]);
  });

  it("breaks a sort_order tie by name — ties are legal per the column comment", () => {
    const rows = [
      { name: "Zebra", sort_order: 0 },
      { name: "Alpha", sort_order: 0 },
      { name: "Mid", sort_order: 0 },
    ];
    expect(orderBylines(rows).map((r) => r.name)).toEqual(["Alpha", "Mid", "Zebra"]);
  });

  it("does not mutate its input", () => {
    const rows = [
      { name: "B", sort_order: 1 },
      { name: "A", sort_order: 0 },
    ];
    orderBylines(rows);
    expect(rows[0].name).toBe("B");
  });
});

describe("toBylineDto", () => {
  it("maps the row's snake_case column to the wire's camelCase field", () => {
    const row: BylineRow = { id: "b-1", name: "Trackwork Desk", sort_order: 3, retired_at: null };
    expect(toBylineDto(row)).toEqual({ id: "b-1", name: "Trackwork Desk", sortOrder: 3 });
  });
});

describe("isRetired", () => {
  it("is false for a live row", () => {
    expect(isRetired({ retired_at: null })).toBe(false);
  });

  it("is true once retired_at is set", () => {
    expect(isRetired({ retired_at: "2026-09-20T00:00:00.000Z" })).toBe(true);
  });
});

describe("constants", () => {
  it("MAX_BYLINE_LENGTH is 60", () => {
    expect(MAX_BYLINE_LENGTH).toBe(60);
  });

  it("BYLINE_FIELDS lists the columns the picker needs", () => {
    expect(BYLINE_FIELDS).toBe("id,name,sort_order,retired_at");
  });
});
