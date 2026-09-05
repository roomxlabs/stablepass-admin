import { describe, it, expect } from "vitest";
import { parsePostSort, postsOrder, postsSelect, POST_SORT_KEYS, type PostSort } from "./sort";

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

describe("postsSelect — the horse-name sort needs an INNER embed", () => {
  const SELECT =
    "id,horse_id,type,status,horse:horse_id(display_name,racing_name),trainer:source_trainer_id(name)";

  it("leaves the select byte-identical for the default order", () => {
    expect(postsSelect(SELECT, "")).toBe(SELECT);
  });

  it("leaves the select byte-identical for every non-horse sort", () => {
    for (const sort of ["published", "engagement", "status"] as const) {
      expect(postsSelect(SELECT, sort)).toBe(SELECT);
    }
  });

  it("makes ONLY the horse embed inner when sorting by horse name", () => {
    const out = postsSelect(SELECT, "horse");
    // PostgREST will not order PARENT rows by an embedded column unless the
    // embed is an inner join — without this the sort silently does nothing.
    expect(out).toContain("horse:horse_id!inner(display_name,racing_name)");
    // The trainer embed must NOT become inner: it is a different relationship
    // and turning it inner would change which rows the list returns.
    expect(out).toContain("trainer:source_trainer_id(name)");
    expect(out).not.toContain("trainer:source_trainer_id!inner");
  });
});
