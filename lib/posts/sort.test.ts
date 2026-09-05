import { describe, it, expect } from "vitest";
import { parsePostSort, postsOrder, POST_SORT_KEYS, type PostSort } from "./sort";

describe("parsePostSort", () => {
  it("keeps an allow-listed value", () => {
    for (const key of POST_SORT_KEYS) expect(parsePostSort(key)).toBe(key);
  });

  it("coerces unknown/absent input to ''", () => {
    expect(parsePostSort("bogus")).toBe("");
    expect(parsePostSort(undefined)).toBe("");
    expect(parsePostSort(null)).toBe("");
    expect(parsePostSort(42)).toBe("");
  });
});

describe("postsOrder", () => {
  it('("", dir) is exactly the created_at desc tiebreaker', () => {
    expect(postsOrder("", "asc")).toEqual([{ column: "created_at", ascending: false }]);
    expect(postsOrder("", "desc")).toEqual([{ column: "created_at", ascending: false }]);
  });

  const primaryColumn: Record<PostSort, string> = {
    published: "published_at",
    engagement: "like_count",
    status: "status",
    horse: "horse(display_name)",
  };
  const nullable: Record<PostSort, boolean> = {
    published: true,
    engagement: true,
    status: false,
    horse: false,
  };

  it.each(POST_SORT_KEYS)("orders on the right column for key '%s', tracking dir", (key) => {
    for (const dir of ["asc", "desc"] as const) {
      const [primary] = postsOrder(key, dir);
      expect(primary.column).toBe(primaryColumn[key]);
      expect(primary.ascending).toBe(dir === "asc");
    }
  });

  it.each(POST_SORT_KEYS)("nullsFirst:false is present for nullable columns, absent otherwise ('%s')", (key) => {
    for (const dir of ["asc", "desc"] as const) {
      const [primary] = postsOrder(key, dir);
      if (nullable[key]) {
        expect(primary.nullsFirst).toBe(false);
      } else {
        expect(primary).not.toHaveProperty("nullsFirst");
      }
    }
  });

  it.each(POST_SORT_KEYS)("always ends with the created_at desc tiebreaker ('%s')", (key) => {
    for (const dir of ["asc", "desc"] as const) {
      const order = postsOrder(key, dir);
      expect(order[order.length - 1]).toEqual({ column: "created_at", ascending: false });
    }
  });
});
