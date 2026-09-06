import { describe, it, expect, beforeEach } from "vitest";
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


// ===========================================================================
// scripts/reset-analytics.core.mjs — THE CODE THAT ACTUALLY DELETES ROWS
// (ENG-984 review, MUST-FIX 4)
//
// The tests above cover `lib/analytics/reset.ts`, which is well covered but is
// NOT what runs on launch day. The CLI is. Review proved both of the CLI's
// safety gates could be deleted with a fully green suite:
//
//   A. project-ref guard  `if (!projectRef || projectRef !== derivedRef)` → `if (false)`  → green
//   B. dry-run default    `if (!confirm)`                                → `if (false)`  → green
//
// because the only test covering them asserted that two STRINGS APPEARED IN
// THE SOURCE. A source-text guard on a script that wipes four tables proves
// nothing about what the script does; it survives any mutation that keeps the
// text. Those assertions are deleted, not weakened, and replaced with the
// behaviour: what is deleted, and what is NOT.
//
// The gates are now importable (the CLI is a thin effect wrapper), so these
// drive the real code path with a fake client and an injected client factory.
// Nothing here touches a network, a project, or a real row.
// ===========================================================================
import {
  runResetCli,
  parseArgs,
  deriveProjectRef,
  RESET_TABLES as CLI_RESET_TABLES,
  TS_COLUMN as CLI_TS_COLUMN,
} from "../../scripts/reset-analytics.core.mjs";

const LIVE_URL = "https://abcdefghijklmnop.supabase.co";

/**
 * Records every table a delete was issued against, and every client made.
 *
 * The row counts are STATEFUL — a delete actually empties the fake table — so
 * the CLI's post-delete verification re-count sees the real effect rather than
 * a frozen number. `survives` lets one table refuse to empty, which is the
 * only way to reach the "rows survived the reset" branch.
 */
function cliHarness(opts: { survives?: string } = {}) {
  const deleted: string[] = [];
  const clientsMade: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const rows: Record<string, number> = {
    impression: 7,
    reaction: 7,
    bookmark: 7,
    trainer_website_click: 7,
  };

  const table = (name: string) => ({
    select: () => Promise.resolve({ count: rows[name] ?? 0, error: null }),
    delete: () => ({
      gte: (column: string) => {
        deleted.push(`${name}.${column}`);
        if (name !== opts.survives) rows[name] = 0;
        return Promise.resolve({ error: null });
      },
    }),
  });

  return {
    deleted,
    clientsMade,
    out,
    err,
    args: {
      env: { SUPABASE_URL: LIVE_URL, SUPABASE_SERVICE_ROLE_KEY: "service-key" },
      makeClient: (url: string) => {
        clientsMade.push(url);
        return { from: table };
      },
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
    },
  };
}

describe("reset CLI — GATE B: dry run is the default", () => {
  it("DELETES NOTHING without --confirm, even with a correct --project-ref", async () => {
    const h = cliHarness();
    const code = await runResetCli({
      argv: ["--project-ref=abcdefghijklmnop"],
      ...h.args,
    });

    // The gate that matters: zero mutations.
    expect(h.deleted, "a dry run issued a DELETE").toEqual([]);
    expect(code).toBe(0);
    // ...and it says so, so the operator is never left guessing.
    expect(h.out.join("\n")).toContain("Dry run — no rows deleted.");
    // It still did the read-only pre-flight, which is the point of a dry run.
    expect(h.out.join("\n")).toContain("impression");
  });

  it("with --confirm, deletes ONLY the four reset tables, each on its own timestamp column", async () => {
    const h = cliHarness();
    const code = await runResetCli({
      argv: ["--confirm", "--project-ref=abcdefghijklmnop"],
      ...h.args,
    });

    expect(code).toBe(0);
    expect([...h.deleted].sort()).toEqual(
      (CLI_RESET_TABLES as string[])
        .map((t) => `${t}.${(CLI_TS_COLUMN as Record<string, string>)[t]}`)
        .sort(),
    );
    // The tables this reset must never touch — accounts, money, content, and
    // `follow`, which is member STATE rather than an analytics row.
    const hit = h.deleted.map((d) => d.split(".")[0]);
    for (const safe of ["app_user", "subscription", "post", "horse", "trainer", "follow"]) {
      expect(hit, `reset deleted from ${safe}`).not.toContain(safe);
    }
  });
});

describe("reset CLI — GATE A: the project-ref type-to-confirm guard", () => {
  it("refuses, deletes nothing and OPENS NO CLIENT when --project-ref is missing", async () => {
    const h = cliHarness();
    const code = await runResetCli({ argv: ["--confirm"], ...h.args });

    expect(code).toBe(1);
    expect(h.deleted).toEqual([]);
    // A run aimed at an unnamed project must not even connect to it.
    expect(h.clientsMade, "a refused run still opened a client").toEqual([]);
    expect(h.err.join("\n")).toContain("Refusing to run");
  });

  it("refuses, deletes nothing and OPENS NO CLIENT when --project-ref names a different project", async () => {
    const h = cliHarness();
    const code = await runResetCli({
      argv: ["--confirm", "--project-ref=some-other-project"],
      ...h.args,
    });

    expect(code).toBe(1);
    expect(h.deleted).toEqual([]);
    expect(h.clientsMade).toEqual([]);
  });

  it("does not echo the derived ref or the host on a mismatch (a type-to-confirm, not a copy-paste prompt)", async () => {
    const h = cliHarness();
    await runResetCli({ argv: ["--confirm", "--project-ref=wrong"], ...h.args });

    const text = h.err.join("\n");
    expect(text).not.toContain("abcdefghijklmnop");
    expect(text).not.toContain("supabase.co");
  });

  it("guards the dry run too — a wrong ref never even reaches the pre-flight counts", async () => {
    const h = cliHarness();
    const code = await runResetCli({ argv: ["--project-ref=wrong"], ...h.args });
    expect(code).toBe(1);
    expect(h.clientsMade).toEqual([]);
  });
});

describe("reset CLI — parseArgs / deriveProjectRef", () => {
  it("treats a bare run as a dry run with no ref", () => {
    expect(parseArgs([])).toEqual({ confirm: false, projectRef: null });
  });

  it("only honours the exact --confirm flag", () => {
    expect(parseArgs(["--confirm"]).confirm).toBe(true);
    // Near-misses must NOT arm the delete.
    expect(parseArgs(["--confirm=yes"]).confirm).toBe(false);
    expect(parseArgs(["-c"]).confirm).toBe(false);
    expect(parseArgs(["confirm"]).confirm).toBe(false);
  });

  it("reads the project ref out of --project-ref=", () => {
    expect(parseArgs(["--project-ref=abc123"]).projectRef).toBe("abc123");
  });

  it("derives the ref from a Supabase host, and 'local' from localhost", () => {
    expect(deriveProjectRef("https://abcdefghijklmnop.supabase.co")).toBe("abcdefghijklmnop");
    expect(deriveProjectRef("http://localhost:54321")).toBe("local");
    expect(deriveProjectRef("http://127.0.0.1:54321")).toBe("local");
  });

  it("falls back to the whole host for a non-Supabase URL, so it can never accidentally MATCH", () => {
    // A self-hosted/proxied URL derives to its full host; a ref typed as the
    // first label alone will not match, which fails CLOSED.
    expect(deriveProjectRef("https://db.internal.example.com")).toBe("db.internal.example.com");
  });
});

// The CLI can't import the TS module (it runs under a bare `node`, no TS
// loader), so it re-declares the table list. This used to be policed by
// REGEXING the CLI's source. Now that the CLI's core is importable, the two
// are compared BY VALUE — which is both stronger and immune to formatting.
describe("scripts/reset-analytics.core.mjs stays in step with lib/analytics/reset.ts", () => {
  it("declares the same RESET_TABLES, in the same order", () => {
    expect(CLI_RESET_TABLES).toEqual([...RESET_TABLES]);
  });

  it("declares the same TS_COLUMN mapping", () => {
    expect(CLI_TS_COLUMN).toEqual(TS_COLUMN);
  });
});

describe("reset CLI — post-delete verification", () => {
  it("exits non-zero and names the survivors when rows outlive the reset", async () => {
    // `remaining !== 0` is the only thing separating "deleted" from "attempted
    // to delete". A reset that silently reports success over surviving rows is
    // worse than one that fails, because launch then starts from dirty data.
    const h = cliHarness({ survives: "reaction" });
    const code = await runResetCli({
      argv: ["--confirm", "--project-ref=abcdefghijklmnop"],
      ...h.args,
    });

    expect(code).toBe(1);
    expect(h.err.join("\n")).toMatch(/row\(s\) survived the reset/);
    expect(h.out.join("\n")).toContain("** NOT EMPTY **");
  });

  it("reports before -> after from a RE-COUNT, not from the plan", async () => {
    const h = cliHarness();
    await runResetCli({ argv: ["--confirm", "--project-ref=abcdefghijklmnop"], ...h.args });
    const text = h.out.join("\n");
    expect(text).toContain("Deleted (before -> after):");
    expect(text).toMatch(/impression\s+7 -> 0/);
    expect(text).toContain("All engagement/analytics rows cleared.");
  });
});
