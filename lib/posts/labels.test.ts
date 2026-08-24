// The drift guard for the 13 post-label presets (ENG-745, decision 1).
//
// `POST_LABEL_PRESETS` is a COPY. The originals live in stablepass-be:
//   - docs/specs/api-contract.md          (the documented single source)
//   - supabase/migrations/20260819120001_post_label.sql  (the enforcement)
// Nothing in the type system connects the three, so without this test the copy
// and the CHECK drift apart and the only symptom is a 400 in production on a
// preset the picker happily offered.
//
// Both files are asserted, not just the doc: the doc is what humans copy from,
// the CHECK is what actually rejects a write, and a round-6 mistake in either
// one is exactly the failure this ticket exists to prevent.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { isLabelCheckViolation, isPostLabel, normalisePostLabel, POST_LABEL_PRESETS } from "./labels";

/**
 * Locate the sibling stablepass-be checkout.
 *
 * `process.cwd()` is NOT the repo root when the suite runs inside a
 * `git worktree` (it is `<repo>/.claude/worktrees/<name>`), and the rx implement
 * loop always runs in one — so resolve the real root via git rather than
 * counting `..` segments, then step up to the shared workspace directory that
 * holds all four repos side by side.
 */
function beRepoRoot(): string {
  const gitCommonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
  const adminRoot = dirname(gitCommonDir.replace(/\/\.git\/?$/, "/.git"));
  return join(dirname(adminRoot), "stablepass-be");
}

/**
 * Revisions to look in, after the sibling's working tree, most specific first.
 *
 * The working tree alone is NOT enough: stablepass-be is routinely checked out
 * on a different branch from the one carrying the change (it sat on `main`
 * while this ticket was built, where `post.label` does not exist yet), so a
 * plain `readFileSync` makes the guard fail for a reason that has nothing to do
 * with drift. Reading through git instead makes it independent of whatever the
 * sibling happens to have checked out, and the `main` entries keep it working
 * after round 6 merges and the integration branch is deleted.
 */
const BE_REVS = ["origin/feature/round6-v1", "feature/round6-v1", "origin/main", "main", "HEAD"];

/**
 * The content of a stablepass-be file: the working copy if it has it, else the
 * first revision that does. `predicate` rejects a stale copy that parses but
 * predates the presets, so an older rev cannot satisfy the guard vacuously.
 */
function readBeFile(relPath: string, predicate: (text: string) => boolean): string {
  const root = beRepoRoot();
  const tried: string[] = [];

  const onDisk = join(root, relPath);
  if (existsSync(onDisk)) {
    const text = readFileSync(onDisk, "utf8");
    if (predicate(text)) return text;
    tried.push("working tree");
  }

  for (const rev of BE_REVS) {
    try {
      const text = execFileSync("git", ["show", `${rev}:${relPath}`], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (predicate(text)) return text;
      tried.push(rev);
    } catch {
      // rev or path absent at that rev — keep looking.
    }
  }

  // Deliberately a FAILURE, not a skip. A skipped drift guard is a green suite
  // that proves nothing, which is the exact trap this test exists to close.
  throw new Error(
    `Could not read a current ${relPath} from stablepass-be at ${root} ` +
      `(looked in: working tree, ${BE_REVS.join(", ")}; ` +
      `candidates without the presets: ${tried.join(", ") || "none"}). ` +
      `stablepass-be must be checked out as a sibling of stablepass-admin, with its remote fetched.`,
  );
}

/** Every `backticked` value on the contract doc's preset line, in order. */
function presetsFromContractDoc(md: string): string[] {
  const line = md
    .split("\n")
    .find((l) => l.trimStart().startsWith(">") && l.includes("`Stable Update`"));
  if (!line) throw new Error("Could not find the preset blockquote line in api-contract.md.");
  return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

/** Every quoted value inside the `post_label_preset` CHECK's `in (...)` list. */
function presetsFromMigration(sql: string): string[] {
  const start = sql.indexOf("post_label_preset");
  const inList = sql.slice(start).match(/label in \(([\s\S]*?)\)/);
  if (!inList) throw new Error("Could not find the post_label_preset IN list in the migration.");
  return [...inList[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe("post label presets — drift guard against stablepass-be", () => {
  it("matches docs/specs/api-contract.md exactly, in order", () => {
    const doc = readBeFile("docs/specs/api-contract.md", (t) => t.includes("`Stable Update`"));
    const documented = presetsFromContractDoc(doc);
    expect(documented).toHaveLength(13);
    expect([...POST_LABEL_PRESETS]).toEqual(documented);
  });

  it("matches the post_label_preset CHECK in the migration exactly, in order", () => {
    const sql = readBeFile("supabase/migrations/20260819120001_post_label.sql", (t) =>
      t.includes("post_label_preset"),
    );
    const constrained = presetsFromMigration(sql);
    expect(constrained).toHaveLength(13);
    expect([...POST_LABEL_PRESETS]).toEqual(constrained);
  });

  // The one preset a human retyping the list gets wrong. `·` (U+00B7) looks
  // near-identical to a hyphen, a bullet (U+2022) and a katakana middle dot at
  // most font sizes, and the CHECK compares bytes.
  it("spells `Race Day · Today` with a U+00B7 MIDDLE DOT, not a hyphen or bullet", () => {
    const raceDay = POST_LABEL_PRESETS.find((p) => p.startsWith("Race Day"));
    expect(raceDay).toBe("Race Day · Today");
    expect(Buffer.from(raceDay!, "utf8").toString("hex")).toContain("c2b7");
    expect(raceDay).not.toContain("-");
    expect(raceDay).not.toContain("•");
  });

  it("has no duplicates", () => {
    expect(new Set(POST_LABEL_PRESETS).size).toBe(POST_LABEL_PRESETS.length);
  });

  // Guardrail 6 — no betting / bookmaker anything. The CHECK is the real
  // enforcement (stablepass-be asserts it too); this is the admin-side echo so
  // a preset added here without a migration still trips a guardrail test.
  it("contains no betting or bookmaker terminology", () => {
    const banned = /\b(odds|bet|betting|bookmaker|wager|tip|tips|tipping|punt|market)\b/i;
    for (const preset of POST_LABEL_PRESETS) expect(preset).not.toMatch(banned);
  });
});

describe("isPostLabel / normalisePostLabel", () => {
  it("accepts every preset and rejects an off-list value", () => {
    for (const preset of POST_LABEL_PRESETS) expect(isPostLabel(preset)).toBe(true);
    expect(isPostLabel("Betting Tips")).toBe(false);
    // A hyphen instead of the middle dot is the realistic near-miss.
    expect(isPostLabel("Race Day - Today")).toBe(false);
    expect(isPostLabel("")).toBe(false);
    expect(isPostLabel(null)).toBe(false);
  });

  it("normalises an explicit clear to null and an off-list value to undefined", () => {
    expect(normalisePostLabel("Trackwork")).toBe("Trackwork");
    expect(normalisePostLabel(null)).toBeNull();
    expect(normalisePostLabel("")).toBeNull();
    expect(normalisePostLabel("Betting Tips")).toBeUndefined();
    expect(normalisePostLabel(42)).toBeUndefined();
  });
});

describe("isLabelCheckViolation", () => {
  const msg = (c: string) => `new row for relation "post" violates check constraint "${c}"`;

  it("claims a violation of post_label_preset", () => {
    expect(isLabelCheckViolation({ code: "23514", message: msg("post_label_preset") })).toBe(true);
    // Some drivers put the constraint in `details` instead.
    expect(isLabelCheckViolation({ code: "23514", message: "", details: msg("post_label_preset") })).toBe(true);
  });

  it("does NOT claim another CHECK on the same table", () => {
    // `post` also CHECKs type, status and aspect_ratio; all raise 23514. The
    // bare code is not evidence that the label is what went wrong.
    for (const c of ["post_type_check", "post_status_check", "post_aspect_ratio_positive"]) {
      expect(isLabelCheckViolation({ code: "23514", message: msg(c) })).toBe(false);
    }
  });

  it("does not claim a non-CHECK error, or no error at all", () => {
    expect(isLabelCheckViolation({ code: "23505", message: msg("post_label_preset") })).toBe(false);
    expect(isLabelCheckViolation({ code: "PGRST116", message: "no rows" })).toBe(false);
    expect(isLabelCheckViolation(null)).toBe(false);
    expect(isLabelCheckViolation({})).toBe(false);
  });
});
