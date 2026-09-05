import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";
import { planReset, runReset, RESET_TABLES, TS_COLUMN } from "./reset";

const state: FakeState = blankState();

beforeEach(() => {
  Object.assign(state, blankState());
  state.tables.impression = { select: { count: 10 } };
  state.tables.reaction = { select: { count: 20 } };
  state.tables.bookmark = { select: { count: 5 } };
  state.tables.trainer_website_click = { select: { count: 2 } };
});

describe("planReset", () => {
  it("counts rows per table and writes nothing", async () => {
    const sb = makeFakeClient(state) as unknown as Parameters<typeof planReset>[0];
    const plan = await planReset(sb);
    expect(plan).toEqual([
      { table: "impression", rows: 10 },
      { table: "reaction", rows: 20 },
      { table: "bookmark", rows: 5 },
      { table: "trainer_website_click", rows: 2 },
    ]);
    expect(state.calls.mutations).toEqual([]);
  });
});

describe("runReset", () => {
  it("without confirm, records the plan but performs zero mutations", async () => {
    const sb = makeFakeClient(state) as unknown as Parameters<typeof runReset>[0];
    const result = await runReset(sb, { confirm: false });
    expect(result.deleted).toBe(false);
    expect(result.plan).toEqual([
      { table: "impression", rows: 10 },
      { table: "reaction", rows: 20 },
      { table: "bookmark", rows: 5 },
      { table: "trainer_website_click", rows: 2 },
    ]);
    expect(state.calls.mutations).toEqual([]);
  });

  it("with confirm:true, deletes exactly the four reset tables and no others", async () => {
    const sb = makeFakeClient(state) as unknown as Parameters<typeof runReset>[0];
    const result = await runReset(sb, { confirm: true });
    expect(result.deleted).toBe(true);

    const deletedTables = state.calls.mutations.filter((m) => m.op === "delete").map((m) => m.table);
    expect(deletedTables.sort()).toEqual([...RESET_TABLES].sort());
    expect(deletedTables).not.toContain("post");
    expect(deletedTables).not.toContain("app_user");
    expect(deletedTables).not.toContain("subscription");
    expect(deletedTables).not.toContain("follow");
  });

  // Without this, an UNFILTERED `.delete()` — or one filtered on the wrong
  // column — passes the test above just as green as a correct one, because that
  // test only reads which TABLE was hit. The fake records `gte` filters
  // precisely so the predicate itself can be asserted.
  it("filters each delete on that table's own timestamp column", async () => {
    const sb = makeFakeClient(state) as unknown as Parameters<typeof runReset>[0];
    await runReset(sb, { confirm: true });

    for (const table of RESET_TABLES) {
      const del = state.calls.mutations.find((m) => m.op === "delete" && m.table === table);
      expect(del, `no delete recorded for ${table}`).toBeDefined();
      const gte = del!.filters.find((f) => f.op === "gte");
      expect(gte, `delete on ${table} carried no gte filter — an unfiltered delete`).toBeDefined();
      expect(gte!.column).toBe(TS_COLUMN[table]);
    }
  });
});

// The CLI that actually runs on launch day (`scripts/reset-analytics.mjs`)
// cannot import this module without a TS loader, so it hand-copies the table
// list and timestamp map. That means the code under test above is NOT the code
// that deletes production rows. This guard is what stops the two drifting:
// if someone adds a table to one copy and not the other, this fails.
describe("scripts/reset-analytics.mjs stays in step with this module", () => {
  const cliSource = readFileSync(
    join(process.cwd(), "scripts", "reset-analytics.mjs"),
    "utf8",
  );

  it("declares the same RESET_TABLES, in the same order", () => {
    const m = /const RESET_TABLES = \[([^\]]*)\]/.exec(cliSource);
    expect(m, "could not find RESET_TABLES in the CLI").not.toBeNull();
    const cliTables = m![1]
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    expect(cliTables).toEqual([...RESET_TABLES]);
  });

  it("declares the same TS_COLUMN mapping", () => {
    const m = /const TS_COLUMN = \{([^}]*)\}/.exec(cliSource);
    expect(m, "could not find TS_COLUMN in the CLI").not.toBeNull();
    const cliMap: Record<string, string> = {};
    for (const line of m![1].split(",")) {
      const kv = /^\s*([A-Za-z_]+)\s*:\s*["']([^"']+)["']\s*$/.exec(line);
      if (kv) cliMap[kv[1]] = kv[2];
    }
    expect(cliMap).toEqual(TS_COLUMN);
  });

  it("still defaults to a dry run and only deletes behind --confirm", () => {
    // Cheap textual guard on the two properties that make this script safe.
    expect(cliSource).toMatch(/argv\.includes\("--confirm"\)/);
    expect(cliSource).toMatch(/Dry run — no rows deleted\./);
  });
});
