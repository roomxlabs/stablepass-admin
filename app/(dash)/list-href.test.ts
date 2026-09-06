import { describe, it, expect } from "vitest";
import {
  buildListHref,
  parseSortDir,
  parseSortKey,
  nextSortDir,
  ariaSortFor,
  compareValues,
} from "./list-href";

describe("buildListHref", () => {
  it("drops undefined/null/''/false/0 and keeps real values", () => {
    const href = buildListHref("/posts", {
      status: "draft",
      q: "",
      horseId: undefined,
      trainerId: null,
      archived: false,
      offset: 0,
      limit: 50,
    });
    expect(href).toBe("/posts?status=draft&limit=50");
  });

  it("returns the bare path when every param is empty", () => {
    const href = buildListHref("/horses", { q: "", trainerId: null, sort: undefined, offset: 0 });
    expect(href).toBe("/horses");
  });

  it("round-trips through URL parsing: searchParams match what went in", () => {
    const params = { status: "published", q: "win", sort: "published", dir: "asc", offset: 20 };
    const href = buildListHref("/posts", params);
    const url = new URL(href, "http://x");
    expect(url.pathname).toBe("/posts");
    for (const [k, v] of Object.entries(params)) {
      expect(url.searchParams.get(k)).toBe(String(v));
    }
  });
});

describe("parseSortDir", () => {
  it("keeps 'asc' and 'desc'", () => {
    expect(parseSortDir("asc")).toBe("asc");
    expect(parseSortDir("desc")).toBe("desc");
  });

  it("falls back to the default (desc) on bad input", () => {
    expect(parseSortDir("bogus")).toBe("desc");
    expect(parseSortDir(undefined)).toBe("desc");
    expect(parseSortDir(null)).toBe("desc");
    expect(parseSortDir(123)).toBe("desc");
  });

  it("falls back to a caller-supplied default", () => {
    expect(parseSortDir("bogus", "asc")).toBe("asc");
  });
});

describe("parseSortKey", () => {
  const allowed = ["trainer", "stable", "horses"] as const;

  it("keeps an allow-listed value", () => {
    expect(parseSortKey("stable", allowed)).toBe("stable");
  });

  it("coerces unknown/absent input to ''", () => {
    expect(parseSortKey("bogus", allowed)).toBe("");
    expect(parseSortKey(undefined, allowed)).toBe("");
    expect(parseSortKey(null, allowed)).toBe("");
    expect(parseSortKey(42, allowed)).toBe("");
  });
});

describe("nextSortDir", () => {
  it("flips the ACTIVE column asc<->desc", () => {
    expect(nextSortDir("published", "published", "asc", "desc")).toBe("desc");
    expect(nextSortDir("published", "published", "desc", "desc")).toBe("asc");
  });

  it("starts an inactive column at its own default", () => {
    expect(nextSortDir("horse", "published", "asc", "asc")).toBe("asc");
    expect(nextSortDir("status", "published", "asc", "asc")).toBe("asc");
    expect(nextSortDir("engagement", "published", "asc", "desc")).toBe("desc");
  });
});

describe("ariaSortFor", () => {
  it("reports the active column's direction", () => {
    expect(ariaSortFor("published", "published", "asc")).toBe("ascending");
    expect(ariaSortFor("published", "published", "desc")).toBe("descending");
  });

  it("reports 'none' for every other column", () => {
    expect(ariaSortFor("status", "published", "asc")).toBe("none");
    expect(ariaSortFor("engagement", "published", "desc")).toBe("none");
  });
});

describe("compareValues", () => {
  it("compares numbers numerically", () => {
    expect(compareValues(2, 10, "asc")).toBeLessThan(0);
    expect(compareValues(10, 2, "asc")).toBeGreaterThan(0);
    expect(compareValues(2, 10, "desc")).toBeGreaterThan(0);
  });

  it("compares strings case-insensitively", () => {
    expect(compareValues("apple", "Banana", "asc")).toBeLessThan(0);
    expect(compareValues("BANANA", "apple", "asc")).toBeGreaterThan(0);
    expect(compareValues("apple", "APPLE", "asc")).toBe(0);
  });

  it.each(["asc", "desc"] as const)("null/undefined/'' SINK in both directions (dir=%s)", (dir) => {
    expect(compareValues(null, "value", dir)).toBeGreaterThan(0);
    expect(compareValues("value", null, dir)).toBeLessThan(0);
    expect(compareValues(undefined, "value", dir)).toBeGreaterThan(0);
    expect(compareValues("value", undefined, dir)).toBeLessThan(0);
    expect(compareValues("", "value", dir)).toBeGreaterThan(0);
    expect(compareValues("value", "", dir)).toBeLessThan(0);
    expect(compareValues(null, undefined, dir)).toBe(0);
    expect(compareValues("", "", dir)).toBe(0);
  });
});
