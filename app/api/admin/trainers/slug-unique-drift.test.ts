// Drift guard: WHY a 409 from POST /api/admin/trainers means "slug collision".
//
// ENG-746's whole point is that the message an admin sees names the real cause.
// The route maps Postgres 23505 (unique_violation) to that 409, and 23505 does
// NOT say WHICH constraint was violated. So the copy in
// lib/trainers/slug-collision.ts is only true while `slug` is the ONLY unique
// constraint on `trainer`. Nothing in TypeScript connects the two: add a
// `unique (name)` in stablepass-be and this app keeps confidently explaining a
// name collision as a slug collision, with a green suite.
//
// This asserts it against the REAL migration text in the sibling repo, so the
// day that stops being true, it stops loudly.
//
// The sibling-resolution technique is the one established by
// lib/posts/labels.test.ts (ENG-745); see that file for the full rationale.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCHEMA = "supabase/migrations/20260704120001_schema.sql";
const ANALYTICS = "supabase/migrations/20260719120000_analytics.sql";
const MIGRATIONS_DIR = "supabase/migrations";

// After the sibling's working tree, most specific first. stablepass-be is
// routinely checked out on a different branch from the one carrying a change,
// so reading through git keeps this independent of that.
const BE_REVS = ["origin/feature/round6-v1", "feature/round6-v1", "origin/main", "main", "HEAD"];

function beRepoRoot(): string {
  const gitCommonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
  // `resolve` is load-bearing: --git-common-dir is absolute only from inside a
  // linked worktree. In a plain checkout it is the bare string ".git", so
  // dirname() would give "." and every lookup below would miss - green for the
  // loop (which runs in a worktree), red for every human dev.
  const adminRoot = dirname(resolve(gitCommonDir));
  return join(dirname(adminRoot), "stablepass-be");
}

function readBeFile(relPath: string, predicate: (text: string) => boolean): string {
  const root = beRepoRoot();
  const onDisk = join(root, relPath);
  if (existsSync(onDisk)) {
    const text = readFileSync(onDisk, "utf8");
    if (predicate(text)) return text;
  }
  for (const rev of BE_REVS) {
    try {
      const text = execFileSync("git", ["show", `${rev}:${relPath}`], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (predicate(text)) return text;
    } catch {
      // rev or path absent at that rev - keep looking.
    }
  }
  // Deliberately a FAILURE, not a skip. A skipped drift guard is a green suite
  // that proves nothing, which is the exact trap this test exists to close.
  throw new Error(
    `Could not read a current ${relPath} from stablepass-be at ${root} ` +
      `(looked in: working tree, ${BE_REVS.join(", ")}). stablepass-be must be a ` +
      `sibling checkout of stablepass-admin, with its remote fetched.`,
  );
}

function listBeMigrations(): string[] {
  const root = beRepoRoot();
  const onDisk = join(root, MIGRATIONS_DIR);
  if (existsSync(onDisk)) return readdirSync(onDisk).filter((f) => f.endsWith(".sql")).sort();
  for (const rev of BE_REVS) {
    try {
      const out = execFileSync("git", ["ls-tree", "--name-only", rev, `${MIGRATIONS_DIR}/`], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const files = out.split("\n").filter((l) => l.endsWith(".sql")).map((l) => l.split("/").pop()!);
      if (files.length) return files.sort();
    } catch {
      // keep looking
    }
  }
  throw new Error(`Could not list ${MIGRATIONS_DIR} in stablepass-be at ${beRepoRoot()}.`);
}

/** The body of `create table trainer (...)`, and only that table. */
function trainerTableBody(sql: string): string {
  // `\s*\(` cannot match `trainer_contact` or `trainer_website_click`.
  const m = sql.match(/create table trainer\s*\(([\s\S]*?)\n\);/i);
  if (!m) throw new Error("Could not find `create table trainer (...)` in the schema migration.");
  return m[1];
}

describe("slug-collision diagnosis - drift guard against stablepass-be", () => {
  it("trainer.slug is the ONLY unique constraint on the table", () => {
    const sql = readBeFile(SCHEMA, (t) => /create table trainer\s*\(/i.test(t));
    const body = trainerTableBody(sql);

    const uniqueLines = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /\bunique\b/i.test(l));

    // Exactly one, and it is the slug column. If this ever fails, the 409 copy
    // in lib/trainers/slug-collision.ts is explaining the wrong cause and must
    // be rewritten before this test is adjusted.
    expect(uniqueLines).toHaveLength(1);
    expect(uniqueLines[0]).toMatch(/^slug\b/);
    expect(uniqueLines[0]).toMatch(/\bunique\b/i);
  });

  it("no later migration adds another unique constraint to trainer", () => {
    // A `unique (name)` added by a later ALTER would break the diagnosis just as
    // thoroughly as one in the original CREATE TABLE, and would be easy to miss.
    //
    // Scanned per STATEMENT, not per line. An earlier version of this test
    // required `unique` and `trainer` on the same physical line, which the house
    // one-line style happens to satisfy - but it silently missed the wrapped form
    //
    //   alter table trainer
    //     add constraint trainer_name_uniq unique (name);
    //
    // where line 1 has no `unique` and line 2's only `trainer` is inside
    // `trainer_name_uniq` (an underscore is a word character, so `\btrainer\b`
    // does not match it). A drift guard with a bypass is exactly the green-suite-
    // that-proves-nothing this file exists to prevent.
    const offenders: string[] = [];
    for (const file of listBeMigrations()) {
      if (file === "20260704120001_schema.sql") continue;
      const sql = readBeFile(`${MIGRATIONS_DIR}/${file}`, () => true);

      // Strip `--` comments, then split into statements and flatten whitespace so
      // a wrapped statement reads as one line.
      const statements = sql
        .split("\n")
        .map((l) => l.replace(/--.*$/, ""))
        .join("\n")
        .split(";")
        .map((st) => st.replace(/\s+/g, " ").trim().toLowerCase())
        .filter(Boolean);

      for (const st of statements) {
        if (!/\bunique\b/.test(st)) continue;
        // Match the TABLE being altered/indexed, not any mention of the word.
        // `\btrainer\b` alone would fire on `references trainer(id)` inside
        // trainer_website_click, which legitimately carries its own constraints.
        const altersTrainer = /^alter table (only )?trainer\b/.test(st);
        const indexesTrainer = /^create unique index\b.*\bon (only )?trainer\b/.test(st);
        const createsTrainer = /^create table (if not exists )?trainer\b/.test(st);
        if (altersTrainer || indexesTrainer || createsTrainer) offenders.push(`${file}: ${st}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("trainer.website_url exists, so this ticket is plumbing not schema work", () => {
    const sql = readBeFile(ANALYTICS, (t) => t.includes("website_url"));
    expect(sql).toMatch(/alter table trainer\s+add column website_url text/i);
  });
});
