// The drift guard for the post-label presets (ENG-745; reshaped by ENG-989).
//
// `POST_LABEL_PRESETS` is a COPY. The originals live in stablepass-be:
//   - docs/specs/api-contract.md                         (the documented source)
//   - supabase/migrations/20260904120000_post_label_table.sql  (the enforcement)
// Nothing in the type system connects the three, so without this test the copy
// and the database drift apart and the only symptom is a 400 in production on a
// preset the picker happily offered.
//
// ## PRESENCE, not exhaustiveness (ENG-989)
//
// This guard used to assert byte-EQUALITY with a fixed 13-name list. ENG-978
// replaced be's closed `post_label_preset` CHECK with a `post_label` lookup
// table, so a label is now added by INSERTING A ROW, not by shipping a
// migration. be's seeded builtins are a FLOOR, not a closed set — an equality
// assertion would go red the first time an admin uses exactly the feature
// ENG-978 shipped.
//
// So: every builtin be seeds must be PRESENT in admin's array, in be's relative
// order, byte-exact — and admin is free to carry extras. Dropping a builtin is
// still caught (see the non-vacuity tests below, which mutate the array and
// assert the comparison goes red). This mirrors the rescoping be applied to its
// own seed test in PR #66.
//
// Both be files are asserted, not just the doc: the doc is what humans copy
// from, the seeded table is what actually backs the foreign key that rejects a
// write.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  foldLabelName,
  isBannedLabel,
  labelDuplicateKey,
  orderLabels,
  isLabelCheckViolation,
  isPostLabel,
  MAX_LABEL_LENGTH,
  normalisePostLabel,
  POST_LABEL_PRESETS,
} from "./labels";

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
  // `resolve` is load-bearing: --git-common-dir returns an ABSOLUTE path only
  // from inside a linked worktree. In a normal checkout it returns the bare
  // relative string ".git", so dirname() gives "." and the sibling path comes
  // out relative — every lookup misses and the guard fails for a reason that
  // has nothing to do with drift. That would make `npm test` red for every
  // human dev while staying green for the loop, which runs in a worktree.
  const adminRoot = dirname(resolve(gitCommonDir));
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
 * after an integration branch merges and is deleted. NOTE a LOCAL `main` can be
 * behind `origin/main` (it was, while ENG-989 was built), which is why every
 * read is predicate-guarded: a rev whose content predates the change is
 * skipped rather than accepted.
 */
const BE_REVS = [
  "origin/feature/launch-v1",
  "feature/launch-v1",
  "origin/main",
  "main",
  "origin/feature/round6-v1",
  "HEAD",
];

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

/**
 * The names seeded as builtins by be's `post_label` migration, in sort_order.
 *
 * Parses the ENG-978 seed INSERT:
 *   insert into public.post_label (name, is_builtin, sort_order) values
 *       ('Stable Update', true, 1), ...
 * Only rows flagged `true` (is_builtin) count — a non-builtin seed row would be
 * sample data, not part of the floor every client may assume.
 */
function builtinsFromLabelTableMigration(sql: string): string[] {
  const at = sql.indexOf("insert into public.post_label");
  if (at === -1) throw new Error("Could not find the post_label seed INSERT in the migration.");
  const stmt = sql.slice(at, sql.indexOf(";", at));
  const rows = [...stmt.matchAll(/\(\s*'((?:[^']|'')*)'\s*,\s*true\s*,\s*(\d+)\s*\)/g)].map((m) => ({
    name: m[1].replace(/''/g, "'"),
    sortOrder: Number(m[2]),
  }));
  if (rows.length === 0) throw new Error("Parsed no builtin rows out of the post_label seed INSERT.");
  // Sort by sort_order, NOT by the order the rows happen to appear in the file.
  // `sort_order` is what drives be's picker order, and admin's array order feeds
  // the compose picker — today the two coincide, but a row appended with an
  // interleaved sort_order would otherwise assert the wrong order.
  return rows.sort((a, b) => a.sortOrder - b.sortOrder).map((r) => r.name);
}

/**
 * The builtins missing from admin's array, and admin's copy of them out of
 * be's order. Empty + empty means the floor is intact.
 *
 * Split out of the assertions so the NON-VACUITY tests can drive it directly:
 * a guard that cannot be shown to go red on a dropped preset is a green suite
 * that proves nothing.
 */
function driftAgainst(builtins: readonly string[], admin: readonly string[]) {
  const missing = builtins.filter((b) => !admin.includes(b));
  // Admin may carry EXTRAS (a runtime-added label). Compare only the builtins
  // it does have, so an extra anywhere in the array is not itself drift.
  const adminBuiltinsInOrder = admin.filter((a) => builtins.includes(a));
  const expectedOrder = builtins.filter((b) => admin.includes(b));
  return { missing, adminBuiltinsInOrder, expectedOrder };
}

describe("post label presets — drift guard against stablepass-be", () => {
  it("contains every preset documented in docs/specs/api-contract.md, in order", () => {
    // The predicate must reject a rev that PREDATES the change, or the fallback
    // chain "succeeds" on a stale doc and the only thing left standing between
    // it and a green guard is the >= 14 literal below. be's
    // origin/feature/round6-v1 doc satisfies "`Stable Update`" with only 13
    // presets, so key it on the newest builtin instead: a stale rev is then
    // skipped and the loop falls through to a fresh one.
    const doc = readBeFile("docs/specs/api-contract.md", (t) => t.includes("`Trainer Comments`"));
    const documented = presetsFromContractDoc(doc);

    // Non-vacuity floor: the parse must actually have found the list. ENG-978's
    // 14 builtins are pinned permanently by be's post_label_immutable_builtin
    // trigger, so the documented set can only ever GROW.
    expect(documented.length).toBeGreaterThanOrEqual(14);

    const { missing, adminBuiltinsInOrder, expectedOrder } = driftAgainst(documented, POST_LABEL_PRESETS);
    expect(missing, "presets documented by stablepass-be but absent from admin").toEqual([]);
    expect(adminBuiltinsInOrder).toEqual(expectedOrder);
  });

  it("contains every builtin seeded into be's post_label table, in order", () => {
    const sql = readBeFile("supabase/migrations/20260904120000_post_label_table.sql", (t) =>
      t.includes("insert into public.post_label"),
    );
    const seeded = builtinsFromLabelTableMigration(sql);
    expect(seeded.length).toBeGreaterThanOrEqual(14);

    const { missing, adminBuiltinsInOrder, expectedOrder } = driftAgainst(seeded, POST_LABEL_PRESETS);
    expect(missing, "builtins seeded by stablepass-be but absent from admin").toEqual([]);
    expect(adminBuiltinsInOrder).toEqual(expectedOrder);

    // The migration that made the list open must be the one we read: if the old
    // closed CHECK were still there, this guard would be asserting the wrong
    // model of the world. Mirrors be's own PR #66 test.
    expect(sql).toContain("post_label_name_fk");
    expect(sql).toMatch(/drop constraint if exists post_label_preset/);
  });

  // ── Non-vacuity. The guard above passes; these prove it is capable of failing.
  it("goes RED if admin drops one of be's builtins", () => {
    const builtins = ["Stable Update", "Trackwork", "Trainer Comments"];
    const dropped = ["Stable Update", "Trackwork"];
    expect(driftAgainst(builtins, dropped).missing).toEqual(["Trainer Comments"]);
  });

  it("goes RED if admin reorders be's builtins", () => {
    const builtins = ["Stable Update", "Trackwork", "Trainer Comments"];
    const reordered = ["Trackwork", "Stable Update", "Trainer Comments"];
    const { missing, adminBuiltinsInOrder, expectedOrder } = driftAgainst(builtins, reordered);
    expect(missing).toEqual([]);
    expect(adminBuiltinsInOrder).not.toEqual(expectedOrder);
  });

  it("goes RED on a near-miss spelling — a hyphen instead of the middle dot", () => {
    const builtins = ["Race Day \u00b7 Today"];
    expect(driftAgainst(builtins, ["Race Day - Today"]).missing).toEqual(["Race Day \u00b7 Today"]);
  });

  // ── The point of ENG-978: admin may carry a label be never seeded.
  it("stays GREEN when admin carries an extra runtime-added label", () => {
    const builtins = ["Stable Update", "Trackwork", "Trainer Comments"];
    for (const withExtra of [
      ["Stable Update", "Trackwork", "Trainer Comments", "Owner Update"],
      ["Owner Update", "Stable Update", "Trackwork", "Trainer Comments"],
      ["Stable Update", "Owner Update", "Trackwork", "Trainer Comments"],
    ]) {
      const { missing, adminBuiltinsInOrder, expectedOrder } = driftAgainst(builtins, withExtra);
      expect(missing).toEqual([]);
      expect(adminBuiltinsInOrder).toEqual(expectedOrder);
    }
  });

  it("goes RED when stablepass-be seeds a label admin has not adopted yet", () => {
    // be's list is the floor for what admin must KEEP, but a brand-new be label
    // admin has not shipped yet is a real drift — assert we detect it, so this
    // stays an explicit decision rather than an accident.
    const builtins = ["Stable Update", "Trackwork", "Trainer Comments"];
    expect(driftAgainst(builtins, ["Stable Update", "Trackwork"]).missing).toEqual([
      "Trainer Comments",
    ]);
  });

  // The one preset a human retyping the list gets wrong. `\u00b7` (U+00B7) looks
  // near-identical to a hyphen, a bullet (U+2022) and a katakana middle dot at
  // most font sizes, and the foreign key compares bytes.
  it("spells `Race Day \u00b7 Today` with a U+00B7 MIDDLE DOT, not a hyphen or bullet", () => {
    const raceDay = POST_LABEL_PRESETS.find((p) => p.startsWith("Race Day"));
    expect(raceDay).toBe("Race Day \u00b7 Today");
    expect(Buffer.from(raceDay!, "utf8").toString("hex")).toContain("c2b7");
    expect(raceDay).not.toContain("-");
    expect(raceDay).not.toContain("\u2022");
  });

  it("has no duplicates", () => {
    expect(new Set(POST_LABEL_PRESETS).size).toBe(POST_LABEL_PRESETS.length);
  });

  // Guardrail 6 — no betting / bookmaker anything. This used to be backstopped
  // by be's closed CHECK; ENG-978 dropped it, so the database will now accept
  // any inserted `post_label` row. That makes this admin-side echo the only
  // automated check over the presets admin itself ships.
  // TWO checks on purpose, and the duplication is the point.
  //
  // The production pattern screens the presets — but a test that ONLY calls
  // `isBannedLabel` still passes if someone guts `BANNED_LABEL_PATTERN`, which
  // makes it useless as a drift guard for exactly the failure it exists to
  // catch. So an INDEPENDENT literal regex runs alongside it as a tripwire.
  const INDEPENDENT_BANNED =
    /\b(gambl|odds|bet|bets|betting|bookmaker|bookie|wager|tip|tips|tipping|punt|market)\b/i;

  it("contains no betting or bookmaker terminology (independent regex)", () => {
    for (const preset of POST_LABEL_PRESETS) expect(preset).not.toMatch(INDEPENDENT_BANNED);
  });

  it("and the production check agrees with that independent regex", () => {
    for (const preset of POST_LABEL_PRESETS) expect(isBannedLabel(preset)).toBe(false);
  });

  it("the production check has not been gutted — it still blocks the obvious terms", () => {
    // The tripwire. If `BANNED_LABEL_PATTERN` is ever weakened to something
    // permissive, this fails even though every preset still passes.
    for (const term of ["Gambling", "Betting Tips", "Best Odds", "Bookmaker Corner"]) {
      expect(isBannedLabel(term)).toBe(true);
    }
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

  it("normalises an explicit clear to null and an unusable value to undefined", () => {
    expect(normalisePostLabel("Trackwork")).toBe("Trackwork");
    expect(normalisePostLabel(null)).toBeNull();
    expect(normalisePostLabel("")).toBeNull();
    expect(normalisePostLabel("Betting Tips")).toBeUndefined();
    expect(normalisePostLabel(42)).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // ENG-979 — the validator stopped being the gate on WHICH labels exist.
  //
  // Since ENG-978 the live allowed set is the `post_label` TABLE, which an
  // admin adds to at runtime. A validator pinned to this compile-time array
  // would reject the very categories Add-new creates, so it now screens only
  // for things that are wrong regardless of the table's contents, and lets
  // `post_label_name_fk` decide the rest.
  // -------------------------------------------------------------------------
  describe("ENG-979 · runtime-added labels pass through to the FK", () => {
    it("accepts a well-formed name that is in no preset array", () => {
      expect(normalisePostLabel("Owner Update")).toBe("Owner Update");
    });

    it("accepts the hyphen near-miss — the DATABASE refuses it, not this", () => {
      // It names no `post_label` row, so the foreign key rejects it with 23503
      // and both post routes map that to a 400. The validator cannot tell a
      // typo from a category created five minutes ago.
      expect(normalisePostLabel("Race Day - Today")).toBe("Race Day - Today");
    });

    it("trims, because the column's own constraint requires a btrim'd name", () => {
      // `post_label_name_not_blank` is `name = btrim(name)`, so an untrimmed
      // value could never match a stored row.
      expect(normalisePostLabel("  Owner Update  ")).toBe("Owner Update");
      expect(normalisePostLabel("   ")).toBeNull();
    });

    it("still refuses a non-string — that is a type error, not a category", () => {
      expect(normalisePostLabel(42)).toBeUndefined();
      expect(normalisePostLabel({})).toBeUndefined();
      expect(normalisePostLabel(true)).toBeUndefined();
    });

    it("still refuses an over-long name", () => {
      expect(normalisePostLabel("x".repeat(MAX_LABEL_LENGTH))).toBe("x".repeat(MAX_LABEL_LENGTH));
      expect(normalisePostLabel("x".repeat(MAX_LABEL_LENGTH + 1))).toBeUndefined();
    });

    // Guardrail 6 stays a HARD reject on the write path, independently of the
    // Add-new route: a post write is a second way to put a name on a member's
    // screen, and be's database no longer refuses one on its own.
    it.each(["Betting Tips", "Best Odds", "Bookmaker Corner", "Tipping Update", "Punting Notes", "Market Movers"])(
      "still refuses the gambling-flavoured name %s",
      (name) => {
        expect(normalisePostLabel(name)).toBeUndefined();
        expect(isBannedLabel(name)).toBe(true);
      },
    );

    // The bypass table from review. The FIRST version of this check enumerated
    // singulars only (`bookmaker`, `tip`, `punt`) and was `\\b`-anchored, so every
    // one of these passed straight through — and `Bookmakers` / `Tipsters` /
    // `Punters` are what an operator would actually type, not exotic attacks.
    // These cases exist so a future "tidy-up" of the pattern cannot silently
    // reopen the hole.
    it.each([
      "Bookmakers",
      "Bookmaking",
      "Tipster",
      "Tipsters",
      "Tipped",
      "Punters",
      "Bettor",
      "Bettors",
      "Wagerings",
      "Multibet",
      "Sportsbet",
      "Betfair",
      "Trifecta",
      "Exotics",
      "Each-Way Odds",
      // Second-review leaks: a plain English word the first pattern missed
      // entirely, the dominant AU wagering brand, and AU exotics/multi
      // vocabulary an operator would plausibly type.
      "Gambling",
      "Gamble",
      "TAB Update",
      "Neds",
      "Unibet",
      "PointsBet",
      "Same Race Multi",
      "Quaddie",
      "Quadrella",
      "First Four",
      "Each Way",
      "Roughies",
      "Blackbook",
      "Staking Plan",
      // U+00AD SOFT HYPHEN — renders as "Odds"/"betting", split the word for a
      // \\b match, and was NOT stripped by the first fix.
      "Od\u00adds",
      "Ti\u00adps",
      "b\u00adetting",
      // Compatibility + zero-width evasions, folded by NFKC / stripping.
      "\uff42\uff45\uff54\uff54\uff49\uff4e\uff47",
      "bett\u200bing",
      "bet\ufeffting",
    ])("refuses the near-miss %s", (name) => {
      expect(isBannedLabel(name)).toBe(true);
      expect(normalisePostLabel(name)).toBeUndefined();
    });

    it("does not refuse ordinary racing vocabulary", () => {
      // Word-boundary anchored, so a banned token inside a longer legitimate
      // word does not trip it.
      // "Better Days" is the reason the bet/bets/betting stems are enumerated
      // individually instead of a blanket `bet\\w*`.
      for (const ok of [
        "Trackwork",
        "Barrier Trial Debrief",
        "Stable Update",
        "Marketing Notes",
        "Better Days",
        "Trainer Comments",
        // Words that merely CONTAIN a banned stem — the false-positive guard.
        "Bettina",
        "Betts Stable",
        "Bookings",
        "Bookkeeping",
        "Oddity",
        "Supermarket Run",
      ]) {
        expect(isBannedLabel(ok)).toBe(false);
        expect(normalisePostLabel(ok)).toBe(ok);
      }
    });
  });
});

// ENG-979 — the duplicate fold. One exported copy, used by the Add-new route's
// pre-check, the name it stores, and the compose client, so they cannot
// disagree about what "the same category" means.
describe("foldLabelName / labelDuplicateKey", () => {
  it("collapses case, surrounding and inner whitespace", () => {
    expect(labelDuplicateKey("  TRACKWORK ")).toBe("trackwork");
    expect(labelDuplicateKey("Race  Day")).toBe(labelDuplicateKey("Race Day"));
    expect(labelDuplicateKey("trackwork")).toBe(labelDuplicateKey("Trackwork"));
  });

  it("NFKC-normalises, so a fullwidth or decomposed spelling is not a second category", () => {
    // Fullwidth T. Without NFKC this is a distinct row that looks identical in
    // the picker.
    expect(labelDuplicateKey("\uff34rackwork")).toBe("trackwork");
    // NFD (e + combining acute) vs NFC (é) — the same word to a human.
    expect(labelDuplicateKey("Cafe\u0301 Notes")).toBe(labelDuplicateKey("Caf\u00e9 Notes"));
  });

  it("strips invisible characters, so a zero-width twin is not a second category", () => {
    // Also means the ZWSP is never STORED — an invisible character inside a
    // string that renders on a member's feed is not something anyone can debug.
    expect(labelDuplicateKey("Track\u200bwork")).toBe(labelDuplicateKey("Trackwork"));
    expect(foldLabelName("Track\u200bwork")).toBe("Trackwork");
    expect(foldLabelName("Race\u00adDay")).toBe("RaceDay");
  });

  it("keeps genuinely different names apart", () => {
    expect(labelDuplicateKey("Trackwork")).not.toBe(labelDuplicateKey("Trackwork Extras"));
  });

  it("foldLabelName preserves the canonical casing it was given", () => {
    // The fold used for STORING must not lowercase — the stored spelling is
    // what members see.
    expect(foldLabelName("  Owner   Update ")).toBe("Owner Update");
  });
});

describe("orderLabels", () => {
  it("puts builtins first in sort_order, then admin-added ones alphabetically", () => {
    const rows = [
      { name: "Zebra", is_builtin: false, sort_order: 0 },
      { name: "Trial", is_builtin: true, sort_order: 5 },
      { name: "Owner Update", is_builtin: false, sort_order: 0 },
      { name: "Stable Update", is_builtin: true, sort_order: 1 },
    ];
    expect(orderLabels(rows).map((r) => r.name)).toEqual([
      "Stable Update",
      "Trial",
      "Owner Update",
      "Zebra",
    ]);
  });

  it("does not mutate its input", () => {
    const rows = [
      { name: "B", is_builtin: false, sort_order: 0 },
      { name: "A", is_builtin: true, sort_order: 1 },
    ];
    orderLabels(rows);
    expect(rows[0].name).toBe("B");
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

  it("claims a violation of the post_label_name_fk foreign key (the ENG-978 era)", () => {
    // ENG-978 dropped the CHECK; an unknown label is now a FK violation, 23503.
    const fk = `insert or update on table "post" violates foreign key constraint "post_label_name_fk"`;
    expect(isLabelCheckViolation({ code: "23503", message: fk })).toBe(true);
    expect(isLabelCheckViolation({ code: "23503", message: "", details: fk })).toBe(true);
  });

  it("does NOT claim another foreign key on the same table", () => {
    // `post` also references trainer and horse; all raise 23503.
    for (const c of ["post_trainer_id_fkey", "post_horse_id_fkey"]) {
      const m = `insert or update on table "post" violates foreign key constraint "${c}"`;
      expect(isLabelCheckViolation({ code: "23503", message: m })).toBe(false);
    }
  });

  it("does not cross the code and the constraint of the two eras", () => {
    // A 23514 naming the FK, or a 23503 naming the old CHECK, is not coherent —
    // matching either would mean the code is decorative.
    const fk = `violates foreign key constraint "post_label_name_fk"`;
    const chk = `violates check constraint "post_label_preset"`;
    expect(isLabelCheckViolation({ code: "23514", message: fk })).toBe(false);
    expect(isLabelCheckViolation({ code: "23503", message: chk })).toBe(false);
  });

  it("does not claim a non-constraint error, or no error at all", () => {
    expect(isLabelCheckViolation({ code: "23505", message: msg("post_label_preset") })).toBe(false);
    expect(isLabelCheckViolation({ code: "PGRST116", message: "no rows" })).toBe(false);
    expect(isLabelCheckViolation(null)).toBe(false);
    expect(isLabelCheckViolation({})).toBe(false);
  });
});
