import { describe, it, expect } from "vitest";
import {
  parsePostSort,
  postsOrder,
  postsSelect,
  HORSE_EMBED,
  HORSE_EMBED_INNER,
  POSTS_API_SELECT,
  POSTS_PAGE_SELECT,
  POST_SORT_KEYS,
  type PostSort,
} from "./sort";
import { mapPostRow } from "@/app/(dash)/posts/format";

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
  it('("", dir) is exactly the created_at + id tiebreaker, in both directions', () => {
    // The default order — what every caller sending no `?sort=` gets. It must
    // not depend on `dir`, or a stray `?dir=asc` would reverse the library.
    const expected = [
      { column: "created_at", ascending: false },
      { column: "id", ascending: false },
    ];
    expect(postsOrder("", "asc")).toEqual(expected);
    expect(postsOrder("", "desc")).toEqual(expected);
  });

  const primaryColumn: Record<PostSort, string> = {
    published: "published_at",
    engagement: "like_count",
    status: "status",
    horse: "horse(display_name)",
  };
  // `horse` is nullable too: HorseEmbed.display_name is `string | null`.
  const nullable: Record<PostSort, boolean> = {
    published: true,
    engagement: true,
    status: false,
    horse: true,
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

  it.each(POST_SORT_KEYS)("always ends with the created_at + id tiebreakers ('%s')", (key) => {
    for (const dir of ["asc", "desc"] as const) {
      const order = postsOrder(key, dir);
      expect(order.slice(-2)).toEqual([
        { column: "created_at", ascending: false },
        { column: "id", ascending: false },
      ]);
    }
  });
});

describe("postsSelect — the horse-name sort needs an INNER embed", () => {
  // Anchored on the strings the app ACTUALLY sends, not a literal written here.
  // A test that invents its own select proves the helper and nothing about the
  // wiring: reformat either real constant and the horse sort would quietly stop
  // ordering while a literal-based test stayed green.
  const REAL = [
    ["page", POSTS_PAGE_SELECT],
    ["api", POSTS_API_SELECT],
  ] as const;

  it.each(REAL)("leaves the %s select byte-identical for the default order", (_n, select) => {
    expect(postsSelect(select, "")).toBe(select);
  });

  it.each(REAL)("leaves the %s select byte-identical for every non-horse sort", (_n, select) => {
    for (const sort of ["published", "engagement", "status"] as const) {
      expect(postsSelect(select, sort)).toBe(select);
    }
  });

  it.each(REAL)("makes ONLY the horse embed inner in the %s select", (_n, select) => {
    const out = postsSelect(select, "horse");
    expect(out).toContain(HORSE_EMBED_INNER);
    // The trainer embed must NOT become inner — it is a different relationship,
    // and making it inner would change WHICH ROWS the list returns.
    expect(out).toContain("trainer:source_trainer_id(name)");
    expect(out).not.toContain("trainer:source_trainer_id!inner");
    // Nothing else moved.
    expect(out.replace("!inner", "")).toBe(select);
  });

  it("THROWS rather than silently returning the input when the embed is missing", () => {
    // `String.replace` with a non-matching needle returns the original string,
    // so without this guard a renamed alias degrades the sort to a no-op that
    // still produces a perfectly valid query.
    expect(() => postsSelect("id,horse_id,type,status", "horse")).toThrow(/horse:horse_id\(/);
  });

  it("does not throw for a missing embed when the sort is not `horse`", () => {
    expect(postsSelect("id,status", "published")).toBe("id,status");
  });
});

describe("postsOrder — the tiebreaker is TOTAL, not merely stable", () => {
  it("ends every order with created_at desc THEN id desc", () => {
    for (const sort of ["", ...POST_SORT_KEYS] as const) {
      for (const dir of ["asc", "desc"] as const) {
        const specs = postsOrder(sort as PostSort | "", dir);
        const tail = specs.slice(-2);
        // created_at alone is not unique (bulk/imported rows share a
        // timestamp), so the PK is what actually makes offset pagination
        // total: without it a row can appear on two pages, or on neither.
        expect(tail).toEqual([
          { column: "created_at", ascending: false },
          { column: "id", ascending: false },
        ]);
      }
    }
  });

  it("sinks NULLs for every nullable sort column, in BOTH directions", () => {
    // published_at is null for drafts, like_count before any engagement, and
    // horse.display_name is typed `string | null`. A null floating to the top
    // of a descending sort buries the rows the operator asked to see.
    for (const sort of ["published", "engagement", "horse"] as const) {
      for (const dir of ["asc", "desc"] as const) {
        expect(postsOrder(sort, dir)[0].nullsFirst).toBe(false);
      }
    }
  });

  it("omits nullsFirst for the non-nullable column", () => {
    expect(postsOrder("status", "asc")[0].nullsFirst).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The select strings are LOAD-BEARING, and nothing else can see them.
//
// This block exists because of a real near-miss while rebasing ENG-963 onto
// #86 (ENG-979): the two changes collide on `POST_FIELDS` in
// app/(dash)/posts/page.tsx — #86 ADDED `label` to it, this PR MOVED it to
// POSTS_PAGE_SELECT. Resolving that conflict in this PR's favour without
// re-adding `label` makes every post in the library fall back to
// "Untitled post" — with a completely GREEN suite, because format.test.ts
// exercises `mapPostRow` on hand-written row objects and never sees the
// projection the page actually sends. `tsc` cannot see it either: a too-narrow
// `.select()` is just a string.
//
// So: assert the columns by name, and assert WHY each matters where the
// consequence is invisible.
describe("POSTS_PAGE_SELECT — every column mapPostRow reads", () => {
  // Parse the projection into top-level column names, ignoring what is inside
  // an embed's parentheses (`horse:horse_id(display_name,...)`).
  function topLevelColumns(select: string): string[] {
    let depth = 0;
    let cur = "";
    const out: string[] = [];
    for (const ch of select) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) {
        out.push(cur.trim());
        cur = "";
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out.map((c) => c.split(":")[0].trim());
  }

  const pageColumns = topLevelColumns(POSTS_PAGE_SELECT);

  it.each([
    "id",
    "horse_id",
    "type",
    "status",
    "title",
    "label",
    "body",
    "media_url",
    "mux_playback_id",
    "poster_url",
    "poster_time_s",
    "like_count",
    "published_at",
    "scheduled_for",
    "created_at",
  ])("selects %s", (column) => {
    expect(pageColumns).toContain(column);
  });

  it("selects `label` — dropping it renames every post to 'Untitled post'", () => {
    // The behavioural half of the assertion above. `mapPostRow` names a row by
    // `label`, falling back to `title` and then to "Untitled post"; a post
    // authored after ENG-979 has a label and NO title, so losing the column
    // from the projection is indistinguishable at the mapper from a genuinely
    // unnamed post. This is the failure the select-string assertion prevents.
    const authoredAfterEng979 = {
      id: "p1",
      horse_id: "h1",
      type: "photo",
      status: "published",
      title: null,
      label: "Race day",
      body: "",
      like_count: 0,
      published_at: "2026-08-01T00:00:00Z",
      scheduled_for: null,
      created_at: "2026-08-01T00:00:00Z",
      horse: null,
      trainer: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    expect(mapPostRow(authoredAfterEng979).title).toBe("Race day");
    // …and the same row as it would arrive if `label` were not selected:
    expect(mapPostRow({ ...authoredAfterEng979, label: undefined }).title).toBe("Untitled post");
  });

  it("keeps the horse embed alias the horse sort rewrites", () => {
    // postsSelect() throws on a miss rather than no-opping, but only if the
    // alias is what it expects — pin the two together.
    expect(POSTS_PAGE_SELECT).toContain(HORSE_EMBED);
    expect(POSTS_API_SELECT).toContain(HORSE_EMBED);
  });

  it("selects no owner column (guardrail §4: no owner PII)", () => {
    expect(POSTS_PAGE_SELECT).not.toMatch(/owner/i);
    expect(POSTS_API_SELECT).not.toMatch(/owner/i);
  });
});
