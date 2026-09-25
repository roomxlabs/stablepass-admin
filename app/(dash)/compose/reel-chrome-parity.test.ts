/**
 * THE DRIFT GUARD (ENG-769 decision 2).
 *
 * `app/(dash)/compose/types.ts` and `PostPreview.tsx` duplicate the member
 * card's reel rules by hand — separate repos, no shared package. That
 * duplication has silently drifted TWICE: ENG-747 (the box floored a 9:16 reel
 * at 4:5 for six days after mobile stopped doing so), and then this ticket (the
 * box matched while the chrome did not). Both times the only thing standing
 * between the two copies was a comment saying "keep these in step".
 *
 * A comment is not a guard. This file READS mobile's post-card.tsx and asserts
 * the rules admin implements are the rules mobile actually ships, so a change
 * on either side turns this red.
 *
 * THE THING THAT MAKES IT A GUARD RATHER THAN A DECORATION: every anchor below
 * is REQUIRED to be found. If mobile refactors so a rule can no longer be
 * located, this file FAILS with "the guard has gone blind" rather than quietly
 * passing on zero assertions. A guard that stays green when it can no longer
 * see is exactly the failure mode ENG-750 and ENG-785 both hit this round.
 *
 * ── ENG-1438: THE HEAD MOVED HOUSE ──────────────────────────────────────────
 *
 * The guard worked. Mobile's ENG-1271 (post subjects) refactored the card head
 * into its OWN component — `src/components/post-head.tsx` — and this file went
 * red in four places rather than quietly mirroring a card that no longer
 * exists. That is the guard doing its job, so the fix is to RE-AIM the anchors
 * at the new structure, not to relax them. Three things genuinely changed:
 *
 *   1. `reelHorse` / `reelByline` / `reelMeta` are no longer styles of the
 *      CARD. They live in post-head.tsx, and the name style is `reelName` (the
 *      head is no longer "the horse, always"). So this file now reads TWO
 *      mobile files, at the SAME revision, and both are required.
 *   2. THE LABEL PILL IS NOW ON THE REEL. The card slots the same
 *      `renderLabelPill(styles.labelPillStacked)` into BOTH heads via
 *      `PostHead`'s `below` prop. The old rule ("the pill lives inside the head
 *      row a reel nulls out, so a reel has none by construction") is dead, and
 *      admin's preview — which hid the pill and printed a note explaining why —
 *      was telling the operator something that stopped being true. Admin now
 *      draws the pill on the scrim and the note is gone.
 *   3. THE RACE BADGE IS STILL REEL-LESS, but for a NEW reason: it is no longer
 *      structurally trapped inside the suppressed row — it is a slot
 *      (`above={raceBadgeNode}`) the card passes to the CLASSIC head only. Same
 *      outcome, different mechanism, so the anchor had to move with it.
 *
 * The scale constants (`HEAD_NAME_SIZE` and friends) are exported from
 * post-head.tsx as named constants rather than spelled inline, so `styleNumber`
 * resolves those too — and throws if it cannot, exactly as it does for a
 * `Spacing.*` it cannot find.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ASPECT_MIN,
  REEL_ASPECT_MIN,
  isReelPreview,
  resolveAspect,
} from "./types";

// ---------------------------------------------------------------------------
// Locating mobile
// ---------------------------------------------------------------------------

/**
 * Walk UP from the admin repo until a sibling `stablepass-mobile` appears.
 *
 * NOT a fixed `../stablepass-mobile`: a loop worker runs in
 * `stablepass-admin/.claude/worktrees/<ticket>`, which is three levels deeper
 * than the main checkout, so a fixed relative depth resolves in one and not the
 * other. This ticket called that out specifically. `process.cwd()` (vitest's
 * root) rather than `import.meta.url`, for the reason compose-css.test.ts
 * documents: under Vitest `import.meta.url` is not a file: URL.
 */
function findMobileRepo(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, "stablepass-mobile");
    if (existsSync(join(candidate, "src/components/post-card.tsx"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const MOBILE_REPO = findMobileRepo();

/**
 * WHICH REVISION of the member card is the contract.
 *
 * The FIRST REF THAT EXISTS wins — deterministically, not "the first that
 * makes the test pass", which would be no guard at all. Admin's preview mirrors
 * the member card as it stands on the CURRENT integration branch, so that
 * branch is asked for first; once it merges and is deleted, `origin/main`
 * carries the same rules and takes over; the working tree is the last resort
 * for a checkout with no remote.
 *
 * This ordering is load-bearing and was found the hard way: the local mobile
 * checkout sits on whatever branch its owner last used (today `android/release`),
 * which is not the revision admin mirrors. Reading the working tree — the
 * obvious implementation — would mirror an arbitrary revision and quietly
 * verify nothing about the rules this file exists to encode.
 *
 * ENG-1438 retired `origin/feature/round6-v1` — it still exists, but it predates
 * mobile's ENG-1271 and carries no post-head.tsx, so asking for it first would
 * resolve the card to a revision the head has not split out of yet and send
 * this guard loudly blind. It is replaced by
 * `origin/feature/release-v1`: that is where the post
 * subject work (mobile ENG-1271) lives and it is the branch admin's own
 * `feature/release-v1` is integrated against. NOTE that post-head.tsx does NOT
 * exist on `origin/main` yet — so if release-v1 disappears before it merges,
 * this guard goes BLIND (loudly) rather than green. That is the correct
 * failure: it means nobody has re-derived the contract.
 */
const CONTRACT_REFS = [
  "origin/feature/release-v1",
  "origin/main",
] as const;

/**
 * Is MOBILE_REPO the ROOT of its own git repo?
 *
 * `git -C <dir>` resolves against whatever repository CONTAINS <dir>, not the
 * directory itself. Without this check, a `stablepass-mobile` folder that
 * happens to sit inside another checkout would have its refs resolved in that
 * outer repo — asking admin's own history for a mobile file. Found by
 * mutation-testing this guard, which is exactly what it is for.
 */
function mobileIsOwnRepo(): boolean {
  if (!MOBILE_REPO) return false;
  try {
    const top = execFileSync("git", ["-C", MOBILE_REPO, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return top === MOBILE_REPO;
  } catch {
    return false;
  }
}

const MOBILE_IS_OWN_REPO = mobileIsOwnRepo();

function showAtRef(rel: string, ref: string): string | null {
  try {
    // rev-parse proves the ref exists; `show` can still fail if the path
    // moved within that revision, so both are inside the try.
    execFileSync("git", ["-C", MOBILE_REPO!, "rev-parse", "--verify", "--quiet", ref], {
      stdio: "ignore",
    });
    return execFileSync("git", ["-C", MOBILE_REPO!, "show", `${ref}:${rel}`], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** One mobile file, at the first contract ref that has it. */
function readMobileFile(rel: string): { source: string; origin: string } | null {
  if (!MOBILE_REPO) return null;

  if (MOBILE_IS_OWN_REPO) {
    for (const ref of CONTRACT_REFS) {
      const source = showAtRef(rel, ref);
      if (source !== null) return { source, origin: `${MOBILE_REPO} @ ${ref}` };
    }
  }

  const path = join(MOBILE_REPO, rel);
  if (!existsSync(path)) return null;
  return { source: readFileSync(path, "utf8"), origin: `${path} (working tree)` };
}

const CARD = readMobileFile("src/components/post-card.tsx");

/**
 * post-head.tsx, at the SAME revision the card came from (ENG-1271).
 *
 * Pinned to the card's own origin rather than re-running the ref search: the
 * two files are one component split in two, and reading the head from a
 * DIFFERENT revision than the card would compare a scrim to a name style that
 * never shipped together. If the card came from a ref and the head is not in
 * that ref, this returns null and every head-derived assertion goes BLIND —
 * which is right, because the split is exactly the kind of refactor that must
 * be re-derived by a human and not guessed at by a fallback.
 */
function readMemberHead(): { source: string; origin: string } | null {
  if (!MOBILE_REPO || !CARD) return null;
  const rel = "src/components/post-head.tsx";
  const ref = CARD.origin.split(" @ ")[1];
  if (ref) {
    const source = showAtRef(rel, ref);
    return source === null ? null : { source, origin: `${MOBILE_REPO} @ ${ref}` };
  }
  const path = join(MOBILE_REPO, rel);
  if (!existsSync(path)) return null;
  return { source: readFileSync(path, "utf8"), origin: `${path} (working tree)` };
}

const HEAD = readMemberHead();

/** `src/theme/tokens.ts` from the SAME revision the card was read from. */
function readMemberTokens(): string | null {
  if (!MOBILE_REPO || !CARD) return null;
  const rel = "src/theme/tokens.ts";
  const ref = CARD.origin.split(" @ ")[1];
  if (ref) {
    const source = showAtRef(rel, ref);
    if (source !== null) return source;
    /* fall through to the working tree */
  }
  const path = join(MOBILE_REPO, rel);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

const TOKENS = readMemberTokens();

// ---------------------------------------------------------------------------
// Extracting rules — every helper THROWS rather than returning a default
// ---------------------------------------------------------------------------

function cardSource(): string {
  if (!CARD) {
    throw new Error(
      "THE GUARD HAS GONE BLIND: could not find stablepass-mobile's " +
        "src/components/post-card.tsx by walking up from " +
        `${process.cwd()}. This test exists to stop admin's reel rules drifting ` +
        "from the member card; it cannot do that without the member card. " +
        "Clone stablepass-mobile beside stablepass-admin, or pin the rules here " +
        "by hand and say so in the PR.",
    );
  }
  return CARD.source;
}

/**
 * post-head.tsx's source, or a loud failure (ENG-1271 moved the head here).
 *
 * Deliberately symmetrical with `cardSource()`: a missing head is as blinding
 * as a missing card, because half the reel chrome's VALUES now live in it.
 */
function headSource(): string {
  if (!HEAD) {
    throw new Error(
      "THE GUARD HAS GONE BLIND: found the member card " +
        `(${CARD?.origin}) but not src/components/post-head.tsx at the SAME ` +
        "revision. Mobile's ENG-1271 split the card head into that file, and " +
        "the reel's name/byline/meta styles live there now. Either the split " +
        "was reverted, or the file moved again, or the contract ref predates " +
        "it — re-derive the anchor, do not delete the assertion.",
    );
  }
  return HEAD.source;
}

/** One capture group out of the member card, or a loud failure. */
function extract(re: RegExp, what: string): string {
  const m = cardSource().match(re);
  if (!m) {
    throw new Error(
      `THE GUARD HAS GONE BLIND: could not locate ${what} in the member card ` +
        `(${CARD?.origin}). The rule did not necessarily change — the SHAPE of ` +
        "the code did, so this guard can no longer see it. Re-derive the anchor " +
        "from post-card.tsx and update this file; do not delete the assertion.",
    );
  }
  return m[1];
}

/**
 * Index of `needle`, ignoring comments and string/template literals.
 *
 * Comment-blind matching would be worse than useless here: post-card.tsx
 * discusses `isReel` at length in prose, so a naive indexOf would happily
 * "find" the rule inside a paragraph explaining it.
 */
function stripNonCode(src: string): string {
  // NEWLINES SURVIVE. Blanking a block comment to plain spaces would fuse the
  // lines it spanned into one, and the block anchors below are line- and
  // indentation-based. (Found by mutation-testing this guard.)
  const blank = (chunk: string) => chunk.replace(/[^\n]/g, " ");
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
      const q = src[i];
      let j = i + 1;
      while (j < n && src[j] !== q) j += src[j] === "\\" ? 2 : 1;
      const stop = Math.min(j + 1, n);
      out += blank(src.slice(i, stop));
      i = stop;
    } else {
      out += src[i];
      i += 1;
    }
  }
  return out;
}

const CODE = CARD ? stripNonCode(CARD.source) : "";
/** The same treatment for post-head.tsx, which is just as prose-heavy. */
const HEAD_CODE = HEAD ? stripNonCode(HEAD.source) : "";

/**
 * The RAW text at a span the stripped CODE located.
 *
 * `stripNonCode` is LENGTH-PRESERVING (it blanks, it does not delete — see the
 * note in it), so an index found in CODE addresses the same character in the
 * original source. That is what lets an anchor be found in the CODE, where a
 * comment cannot forge it, and its VALUE then be read out of the raw source,
 * where the string literal still exists.
 *
 * Both halves are load-bearing. Matching `variant="reel"` against the raw
 * source alone would happily "find" it in the paragraph ABOVE the JSX that
 * explains what `variant="reel"` does — a guard satisfied by its own
 * documentation. Matching against CODE alone cannot see it at all, because the
 * literal has been blanked.
 */
function rawAt(source: string, at: number, length: number): string {
  return source.slice(at, at + length);
}

function codeIndex(needle: string, what: string): number {
  const at = CODE.indexOf(needle);
  if (at === -1) {
    throw new Error(
      `THE GUARD HAS GONE BLIND: ${what} — expected to find \`${needle}\` in the ` +
        `member card's CODE (${CARD?.origin}), outside comments and strings. ` +
        "Re-derive the anchor rather than deleting the assertion.",
    );
  }
  return at;
}

/**
 * The span of the `{isReel ? null : ( ... )}` block that opens at `from`.
 *
 * Anchored on INDENTATION, not paren matching. Paren counting was the first
 * implementation and it silently over-ran to end-of-file, which made the
 * containment assertions below pass trivially — a green guard that was seeing
 * nothing. Mutation-testing caught it; this is the fix, and the reason the
 * mutation check is not optional.
 *
 * The block closes on the first line that is exactly `)}` at the SAME
 * indentation as the line that opened it. Not found => throw, never a default.
 */
function blockSpan(from: number, what: string): [number, number] {
  const lineStart = CODE.lastIndexOf("\n", from) + 1;
  const lineEnd = CODE.indexOf("\n", from);
  const openLine = CODE.slice(lineStart, lineEnd === -1 ? CODE.length : lineEnd);
  const indent = openLine.length - openLine.trimStart().length;

  const rest = CODE.slice(lineEnd + 1);
  let cursor = lineEnd + 1;
  for (const line of rest.split("\n")) {
    const trimmed = line.trim();
    const thisIndent = line.length - line.trimStart().length;
    if (trimmed === ")}" && thisIndent === indent) return [lineStart, cursor];
    cursor += line.length + 1;
  }
  throw new Error(
    `THE GUARD HAS GONE BLIND: could not find the end of ${what} — no line ` +
      `")}" at indent ${indent} after it, in ${CARD?.origin}. The block's shape ` +
      "changed; re-derive the anchor rather than deleting the assertion.",
  );
}

// ---------------------------------------------------------------------------
// The parity assertions
// ---------------------------------------------------------------------------

describe("the member card is reachable at all", () => {
  it("found post-card.tsx and says which revision it read", () => {
    // Deliberately NOT `it.skipIf(...)`. A missing sibling checkout must be a
    // RED test, because "the guard silently did nothing" is the state this
    // whole file exists to make impossible. The message says how to fix it.
    expect(CARD, "stablepass-mobile not found — see cardSource()'s message").not.toBeNull();
    expect(cardSource().length).toBeGreaterThan(1000);
    // Surfaced so a failure elsewhere in this file names its source revision.
    expect(CARD!.origin).toContain("stablepass-mobile");
  });

  it("found post-head.tsx at the SAME revision — the head moved there", () => {
    // ENG-1271. Asserted separately from the card so the failure message says
    // WHICH half is missing: "the card is gone" and "the head split out from
    // under us" need different fixes, and a single combined check would report
    // the wrong one half the time.
    expect(HEAD, "stablepass-mobile's post-head.tsx not found — see headSource()").not.toBeNull();
    expect(headSource().length).toBeGreaterThan(1000);
    // Same revision, not merely the same repo — see readMemberHead().
    expect(HEAD!.origin).toBe(CARD!.origin);
    // The card really does delegate to it, rather than post-head.tsx being a
    // leftover file nothing renders.
    expect(CODE, "post-card.tsx no longer renders <PostHead>").toContain("PostHead");
  });
});

describe("REEL_ASPECT_MIN is mobile's, not a number we made up", () => {
  it("matches the member card's exported constant", () => {
    const expr = extract(
      /export const REEL_ASPECT_MIN\s*=\s*([^;]+);/,
      "mobile's REEL_ASPECT_MIN declaration",
    );
    const frac = expr.match(/^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/);
    const value = frac ? Number(frac[1]) / Number(frac[2]) : Number(expr.trim());
    expect(Number.isFinite(value), `could not read a number out of "${expr}"`).toBe(true);
    expect(REEL_ASPECT_MIN).toBeCloseTo(value, 10);
  });
});

describe("the reel PREDICATE matches the member card's isReel", () => {
  // `const isReel = ...;` — the whole expression, comments already stripped.
  function isReelExpression(): string {
    const at = codeIndex("const isReel", "mobile's isReel declaration");
    const end = CODE.indexOf(";", at);
    expect(end, "unterminated isReel declaration").toBeGreaterThan(at);
    return CODE.slice(at, end);
  }

  it("keys on the VIDEO media type, exactly as admin does", () => {
    const media = isReelExpression().match(/type\s*===\s*\s*(\w+)/);
    // The quotes were stripped with the string literals, so recover the word
    // from the raw source instead, anchored on the same declaration.
    const raw = extract(/const isReel\s*=\s*[\s\S]{0,400}?type\s*===\s*'(\w+)'/, "isReel's media type");
    expect(media ?? raw, "isReel no longer compares a media type").toBeTruthy();
    expect(raw).toBe("video");

    // Admin agrees: video is the ONLY type that can be a reel.
    const portrait = { width: 1080, height: 1920 };
    expect(isReelPreview(portrait, "video")).toBe(true);
    expect(isReelPreview(portrait, "photo")).toBe(false);
    expect(isReelPreview(portrait, "voice")).toBe(false);
    expect(isReelPreview(portrait, "text")).toBe(false);
    expect(isReelPreview(portrait, null)).toBe(false);
  });

  it("uses the same STRICT threshold, read out of mobile's source", () => {
    // The whole point: the number is mobile's, so moving mobile's turns this
    // red instead of leaving admin quietly a threshold behind.
    const decl = extract(
      /const isReel\s*=\s*([\s\S]{0,400}?);/,
      "mobile's isReel expression",
    );
    const cmp = decl.match(/rawAspect\s*(<=?)\s*([0-9.]+)/);
    expect(cmp, `no ratio comparison found in isReel: ${decl}`).not.toBeNull();
    // ONE UPPER BOUND, and no lower bound other than positivity.
    //
    // The match above reads the FIRST comparison, so mobile adding a real lower
    // bound (`rawAspect < 1 && rawAspect > 0.5`) would leave the upper bound
    // still reading `1`, both probes passing, and a 0.4 video a reel in admin
    // while it is a classic card on mobile. Found in review.
    //
    // `rawAspect > 0` is expected and allowed: it is a validity guard, which
    // admin spells as `dims.width > 0 && dims.height > 0`. Anything else is a
    // real bound this preview does not implement.
    const bounds = [...decl.matchAll(/rawAspect\s*(<=?|>=?)\s*([0-9.]+)/g)].map(
      (m) => [m[1], Number(m[2])] as const,
    );
    expect(bounds.filter(([op]) => op.startsWith("<")).length, `upper bounds: ${decl}`).toBe(1);
    for (const [op, bound] of bounds) {
      if (op.startsWith("<")) continue;
      expect(
        bound,
        `mobile's isReel gained a lower bound (${op} ${bound}) that this preview does not model`,
      ).toBe(0);
    }
    const [, operator, bound] = cmp!;
    const threshold = Number(bound);

    // Strictness matters: `< 1` makes a SQUARE video a classic card. If mobile
    // ever relaxes this to `<=`, admin's square-video chrome becomes wrong.
    expect(operator, "mobile's reel comparison stopped being strict").toBe("<");
    expect(threshold).toBeGreaterThan(0);

    // Admin's predicate must flip at mobile's threshold, not at one of its own.
    const justUnder = { width: Math.round(1000 * threshold) - 1, height: 1000 };
    const atBound = { width: Math.round(1000 * threshold), height: 1000 };
    expect(isReelPreview(justUnder, "video")).toBe(true);
    expect(isReelPreview(atBound, "video")).toBe(false);
  });

  it("floors the reel BOX at REEL_ASPECT_MIN, as mobile's aspectStyle does", () => {
    const style = extract(
      /aspectRatio:\s*isReel\s*\?\s*([^:]+):/,
      "mobile's reel aspectRatio expression",
    );
    expect(style).toContain("Math.max");
    expect(style).toContain("REEL_ASPECT_MIN");

    // Taller than 9:16 is floored; between 9:16 and square is drawn as-is.
    expect(resolveAspect({ width: 1080, height: 2400 }, "video")).toBeCloseTo(REEL_ASPECT_MIN, 10);
    expect(resolveAspect({ width: 1080, height: 1920 }, "video")).toBeCloseTo(REEL_ASPECT_MIN, 10);
    expect(resolveAspect({ width: 900, height: 1000 }, "video")).toBeCloseTo(0.9, 10);
    // ...and the classic floor is untouched for everything that is not a reel.
    // Probed BELOW 4:5, which is the only place the classic floor does any
    // work: a 0.9 non-reel is already above it and is drawn at 0.9 unclamped.
    expect(resolveAspect({ width: 1080, height: 1920 }, null)).toBeCloseTo(ASPECT_MIN, 10);
    expect(resolveAspect({ width: 900, height: 1000 }, null)).toBeCloseTo(0.9, 10);
  });
});

/**
 * The span of the `{isReel ? null : ( ... )}` block that holds the classic head.
 *
 * Module scope since ENG-1438: the race-badge rule now needs it too (the badge
 * is a SLOT passed to the head inside this block, not a style that happens to
 * sit in it), and two copies of an anchor is two chances for them to drift
 * apart — which is the whole disease this file treats.
 */
function classicHeadSpan(): [number, number] {
  const at = codeIndex("isReel ? null :", "mobile's white-header-row suppression");
  return blockSpan(at, "the classic head block");
}

describe("the reel CHROME rules match the member card", () => {
  it("stands the white header row down on a reel", () => {
    const [open, close] = classicHeadSpan();
    const block = CODE.slice(open, close);
    // The suppressed block really is the head row, not some other conditional.
    expect(block, "the isReel-suppressed block is not the head row").toContain("styles.head");
  });

  it("slots the LABEL PILL into BOTH heads — a reel now shows one too", () => {
    // THE RULE THIS TICKET RE-AIMED (ENG-1438). It used to read the other way
    // round: the pill lived inside the block the reel branch nulls out, so a
    // reel had none *by construction*, and admin hid the pill and printed a
    // note saying the operator's label would never reach a member.
    //
    // That stopped being true. Mobile builds the pill ONCE
    // (`renderLabelPill(extra)`) and slots it into both heads through
    // `PostHead`'s `below` prop — Naufal, 31 Aug 2026, "the reel follows the
    // post format". So admin now DRAWS the pill on the scrim, and the note is
    // gone. This assertion is what turns red if mobile ever reverses that
    // again, because admin would go back to lying in the opposite direction.
    // The factory is declared as `const renderLabelPill = (extra?) => ...`, so
    // its declaration carries NO `(` after the name and does not show up here.
    // Exactly two CALLS — one per head. Pinning the COUNT is what stops a third
    // head (or a removed one) sliding past: the positional checks below would
    // still pass with an extra call somewhere else in the file.
    const calls = [...CODE.matchAll(/renderLabelPill\(/g)].map((m) => m.index!);
    expect(
      (CODE.match(/const renderLabelPill\s*=/g) ?? []).length,
      "mobile no longer builds its label pill through one factory — there may be two pills that can disagree",
    ).toBe(1);
    expect(
      calls.length,
      `expected mobile to call renderLabelPill exactly twice (one per head); found ${calls.length}`,
    ).toBe(2);

    const [open, close] = classicHeadSpan();
    const inClassic = calls.filter((at) => at > open && at < close);
    const inReel = calls.filter((at) => at > close);
    expect(
      inClassic.length,
      "mobile's classic head no longer slots the label pill — admin still draws it there",
    ).toBe(1);
    expect(
      inReel.length,
      "mobile's REEL head no longer slots the label pill. Admin draws one on the " +
        "scrim on the strength of that; if mobile dropped it, admin must too " +
        "(and the operator must be told again). Re-check both.",
    ).toBe(1);

    // ...and the reel's call really is inside the reel HEADER, not merely
    // somewhere after the classic head. Bounded by two real landmarks rather
    // than a character-distance window: the scrim opens the reel header, and
    // `isReel ? null : followPill` is the statement that follows the whole reel
    // branch, so anything between them is inside it.
    const scrim = codeIndex("styles.reelTopScrim", "mobile's reel scrim");
    const afterReelBranch = codeIndex(
      "isReel ? null : followPill",
      "the end of mobile's reel branch",
    );
    expect(
      afterReelBranch,
      "mobile's reel branch no longer precedes the classic follow pill — re-derive the bounds",
    ).toBeGreaterThan(scrim);
    expect(
      inReel[0] > scrim && inReel[0] < afterReelBranch,
      "mobile's second label pill is not in the reel header — re-derive which head it belongs to",
    ).toBe(true);

    // The pill mobile slots is the STACKED variant, on both heads: it drops out
    // of the name's row to the bottom of the stack. Admin's scrim pill is laid
    // out below the byline because of this, so a revert to the inline 62%-capped
    // chip has to turn this red rather than leaving admin's layout behind.
    expect(
      (CODE.match(/styles\.labelPillStacked(?![A-Za-z])/g) ?? []).length,
      "mobile's heads stopped passing labelPillStacked — the pill's placement changed",
    ).toBe(2);

    // AND the style itself is referenced exactly ONCE — by the factory. (The
    // StyleSheet entry is `labelPill:`, not `styles.labelPill`, so it does not
    // count.) Kept from the old rule, and NOT redundant with the checks above:
    // they only see pills built through `renderLabelPill`, so a BESPOKE
    // `<View style={styles.labelPill} />` dropped straight into the reel scrim
    // creates no extra factory call and no extra `labelPillStacked`, and every
    // other assertion here would stay green while a reel grew a second pill.
    // Caught by mutation-testing this guard — which is what it is for.
    expect(
      (CODE.match(/styles\.labelPill(?![A-Za-z])/g) ?? []).length,
      "mobile references its label pill style somewhere other than the one factory — a head may have gained a second pill",
    ).toBe(1);
  });

  it("stands the FOLLOW pill down on a reel", () => {
    // Recorded even though this preview draws no Follow control at all: that
    // makes "a reel shows no follow pill" true here by construction, and this
    // assertion is what stops a future Follow control being added to the
    // preview's classic AND reel chrome without anyone re-reading the rule.
    expect(CODE).toContain("isReel ? null : followPill");
  });

  it("keeps the caption and reaction bar BELOW the media on a reel", () => {
    // The reel is not the fullscreen player: mobile deliberately does NOT
    // overlay the caption or the action rail on an in-feed reel. Admin's
    // preview leaves both below the box, so this pins the shared decision.
    const [open, close] = classicHeadSpan();
    const head = CODE.slice(open, close);
    expect(head).not.toContain("ReactionBar");
  });
});

describe("what admin deliberately does NOT mirror", () => {
  it("records that the race badge is slotted into the CLASSIC head only", () => {
    // SAME OUTCOME, NEW MECHANISM (ENG-1438). A reel still shows no race badge
    // and admin's preview still drops it — but it is no longer structurally
    // trapped inside the suppressed row. ENG-1271 turned it into a NODE
    // (`raceBadgeNode`) that the card slots into `PostHead`'s `above`, and it
    // passes that slot to the classic head and withholds it from the reel.
    //
    // So the anchor moved from "where is `styles.raceBadge`" to "which heads
    // get `above=`". Both are structural; this one describes what mobile
    // actually does now, which is the difference between a guard and a fossil.
    const [open, close] = classicHeadSpan();

    // The node is built ONCE, outside both heads. More than one construction
    // would mean a second badge somewhere this rule has not looked.
    expect(
      (CODE.match(/const raceBadgeNode\s*=/g) ?? []).length,
      "mobile no longer builds a single raceBadgeNode — re-derive where the badge is drawn",
    ).toBe(1);

    const slots = [...CODE.matchAll(/above=\{raceBadgeNode\}/g)].map((m) => m.index!);
    expect(
      slots.length,
      "mobile slots its race badge into a number of heads other than one — if the " +
        "REEL gained one, admin's preview is now wrong to drop it. Re-check both.",
    ).toBe(1);
    expect(
      slots[0] > open && slots[0] < close,
      "mobile's race badge slot is no longer inside the head row that a reel " +
        "suppresses — admin's preview drops it on reels because of that. Re-check both.",
    ).toBe(true);

    // And nothing else passes an `above` slot: a reel head that gained ANY
    // above-the-name content would put a row admin does not draw on the scrim.
    expect(
      (CODE.match(/\babove=\{/g) ?? []).length,
      "a mobile head gained an `above` slot that is not the race badge — the reel " +
        "scrim's stack order may have changed",
    ).toBe(1);

    // AND the badge STYLE is referenced exactly once. Kept from the old rule,
    // and it is not redundant with the slot count above: a BESPOKE
    // `<View style={styles.raceBadge} />` dropped into the reel scrim builds no
    // second `raceBadgeNode` and passes no second `above=`, so every structural
    // check above stays green while a reel grows a badge admin does not draw.
    // Caught by mutation-testing this guard.
    expect(
      (CODE.match(/styles\.raceBadge(?![A-Za-z])/g) ?? []).length,
      "mobile draws its race badge somewhere other than the one slotted node — a reel may have gained one",
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// THE REEL CHROME'S VALUES (decision 2, second half)
//
// The rules above pin a BOOLEAN — which branch is taken. The reel treatment is
// also a set of NUMBERS (scrim alpha, type sizes, paddings), and those were
// hand-copied into compose.module.css with only a "mirrors mobile" comment for
// provenance. That is precisely the copied-constant-plus-pointer pattern this
// ticket exists to replace, so the values are read out of mobile too: mobile
// re-tuning its reel header now turns this red instead of leaving admin a
// silent redesign behind. (Added after review found M4/M5/M6.)
// ---------------------------------------------------------------------------

/** `Spacing` / `Colors` from mobile's tokens.ts, at the card's own revision. */
function memberTokens(): { spacing: Record<string, number>; colors: Record<string, string> } {
  if (!TOKENS) {
    throw new Error(
      "THE GUARD HAS GONE BLIND: found the member card but not its tokens.ts, " +
        "so Spacing/Colors cannot be resolved. Re-point readMemberTokens().",
    );
  }
  const grab = (name: string) => {
    const m = TOKENS.match(new RegExp(`export const ${name}\\s*=\\s*\\{([\\s\\S]*?)\\}`));
    if (!m) throw new Error(`THE GUARD HAS GONE BLIND: no ${name} in mobile's tokens.ts`);
    return m[1];
  };
  const spacing: Record<string, number> = {};
  for (const m of grab("Spacing").matchAll(/(\w+)\s*:\s*([0-9.]+)/g)) spacing[m[1]] = Number(m[2]);
  const colors: Record<string, string> = {};
  for (const m of grab("Colors").matchAll(/(\w+)\s*:\s*'(#[0-9a-fA-F]{3,8})'/g)) colors[m[1]] = m[2];
  return { spacing, colors };
}

/**
 * The body of one entry in a StyleSheet.create({...}) object, in `code`.
 *
 * ENG-1271 split the card's styles across two files, so the CALLER names which
 * one a style is expected to be in. Deliberately not "look in the card, then
 * fall back to the head": a silent fallback is how a style that MOVED would go
 * unnoticed, and where a rule lives is itself part of the contract this guards.
 */
function styleIn(
  code: string,
  raw: string,
  name: string,
  where: string,
  origin?: string,
): { body: string; rawBody: string } {
  const re = new RegExp(`\\n  ${name}:\\s*\\{`);
  const m = code.match(re);
  if (!m || m.index === undefined) {
    throw new Error(
      `THE GUARD HAS GONE BLIND: mobile's \`${name}\` style — expected ${re} to ` +
        `match ${where}'s CODE (${origin}), outside comments and strings. The ` +
        "style was renamed, moved to another file, or deleted. Re-derive the " +
        "anchor from the mobile source rather than deleting the assertion.",
    );
  }
  const at = m.index;
  const open = code.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          body: code.slice(open + 1, i),
          rawBody: rawAt(raw, open + 1, i - open - 1),
        };
      }
    }
  }
  throw new Error(`THE GUARD HAS GONE BLIND: unbalanced braces in mobile's ${name}`);
}

/**
 * A style declared on the CARD — the scrim, the card padding, the label pill.
 *
 * `.body` has its string literals blanked (safe to search for structure);
 * `.rawBody` still has them (the only place a `'flex-start'` can be read).
 */
function cardStyle(name: string): { body: string; rawBody: string } {
  return styleIn(CODE, cardSource(), name, "post-card.tsx", CARD?.origin);
}

/** A style declared on the HEAD — the reel's name, byline and meta column. */
function headStyle(name: string): { body: string; rawBody: string } {
  return styleIn(HEAD_CODE, headSource(), name, "post-head.tsx", HEAD?.origin);
}

/**
 * post-head.tsx's exported scale constants, e.g. `HEAD_NAME_SIZE = 15`.
 *
 * ENG-869 pulled the four head numbers out into named constants so one edit
 * moves both heads; ENG-1271 carried them into post-head.tsx. `styleNumber`
 * has to resolve them or it could not read `fontSize: HEAD_NAME_SIZE` at all —
 * and a guard that cannot read the size it is guarding is the blind guard this
 * file exists to prevent.
 */
function headConstant(name: string): number | undefined {
  const m = HEAD_CODE.match(new RegExp(`\\bconst ${name}\\s*=\\s*([0-9.]+)\\s*;`));
  return m ? Number(m[1]) : undefined;
}

/**
 * A numeric style property, resolving `Spacing.*` and post-head.tsx's own
 * exported constants to their values.
 */
function styleNumber(block: string, prop: string, what: string): number {
  const m = block.match(new RegExp(`${prop}\\s*:\\s*([A-Za-z0-9_.]+)`));
  if (!m) throw new Error(`THE GUARD HAS GONE BLIND: no ${prop} in ${what}`);
  const raw = m[1];
  if (/^[0-9.]+$/.test(raw)) return Number(raw);
  const spacingKey = raw.match(/^Spacing\.(\w+)$/);
  if (spacingKey) {
    const value = memberTokens().spacing[spacingKey[1]];
    if (value === undefined) throw new Error(`THE GUARD HAS GONE BLIND: no Spacing.${spacingKey[1]}`);
    return value;
  }
  if (/^[A-Z][A-Z0-9_]*$/.test(raw)) {
    const value = headConstant(raw);
    if (value === undefined) {
      throw new Error(
        `THE GUARD HAS GONE BLIND: ${prop} is \`${raw}\` in ${what}, but no ` +
          `\`const ${raw} = <number>\` exists in post-head.tsx (${HEAD?.origin}). ` +
          "Re-derive it rather than inlining a number here — the point is that " +
          "the number is mobile's.",
      );
    }
    return value;
  }
  throw new Error(`THE GUARD HAS GONE BLIND: cannot resolve ${prop}: ${raw} in ${what}`);
}

const ADMIN_CSS = readFileSync(join(process.cwd(), "app/(dash)/compose/compose.module.css"), "utf8");

/** One top-level rule body out of admin's stylesheet. */
function adminRule(selector: string): string {
  const marker = `${selector} {`;
  const at = ADMIN_CSS.indexOf(`\n${marker}`);
  expect(at, `${selector} should exist in compose.module.css`).toBeGreaterThan(-1);
  return ADMIN_CSS.slice(at, ADMIN_CSS.indexOf("}", at));
}

/** `#RRGGBB` -> `r, g, b`, so an alpha colour can be compared to mobile's. */
function rgbOf(hex: string): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h.slice(0, 6);
  const n = parseInt(full, 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

describe("the reel chrome's VALUES are mobile's, not ours", () => {
  it("scrims the header with mobile's ink and alpha", () => {
    // `colors={[withAlpha(Colors.ink, 0.55), 'transparent']}` — read the alpha
    // and the token out of the card rather than trusting the CSS comment.
    const alpha = extract(
      /colors=\{\[withAlpha\(Colors\.ink,\s*([0-9.]+)\)/,
      "mobile's reel scrim gradient",
    );
    const ink = memberTokens().colors.ink;
    expect(ink, "mobile has no Colors.ink").toBeTruthy();
    const scrim = adminRule(".reelScrim");
    expect(scrim.replace(/\s+/g, " ")).toContain(`rgba(${rgbOf(ink)}, ${alpha})`);
  });

  it("uses mobile's scrim geometry", () => {
    // The scrim itself is still the CARD's style — only the head moved.
    const block = cardStyle("reelTopScrim").body;
    const top = styleNumber(block, "paddingTop", "reelTopScrim");
    const side = styleNumber(block, "paddingHorizontal", "reelTopScrim");
    const bottom = styleNumber(block, "paddingBottom", "reelTopScrim");
    const gap = styleNumber(block, "gap", "reelTopScrim");
    const scrim = adminRule(".reelScrim").replace(/\s+/g, " ");
    expect(scrim).toContain(`padding: ${top}px ${side}px ${bottom}px`);
    expect(scrim).toContain(`gap: ${gap}px`);

    // The meta column's own gutter, which is now the HEAD's (`reelMeta` moved
    // to post-head.tsx with the rest of the head). Admin copies it as
    // `padding-right`, and it is what keeps the name off mobile's Follow pill.
    const meta = styleNumber(headStyle("reelMeta").body, "paddingRight", "reelMeta");
    expect(adminRule(".reelMeta").replace(/\s+/g, " ")).toContain(`padding-right: ${meta}px`);
  });

  it("sets the overlaid name and byline at mobile's sizes and colours", () => {
    // `reelHorse` -> `reelName`, and both now live in post-head.tsx (ENG-1271).
    // Admin's CSS class keeps the `.reelHorse` spelling on purpose, for the
    // same reason mobile kept `NAME_ID = 'horse'`: it is the selector the
    // existing admin tests and the e2e specs already reach the name by, and a
    // repo-wide rename for no behaviour change is churn this ticket does not
    // buy. The MAPPING is asserted right here, so the misnomer cannot hide a
    // drift — which is the only thing that made it a misnomer worth keeping.
    const name = headStyle("reelName").body;
    const byline = headStyle("reelByline").body;
    const { colors } = memberTokens();

    const adminName = adminRule(".reelHorse").replace(/\s+/g, " ");
    expect(adminName).toContain(`font-size: ${styleNumber(name, "fontSize", "reelName")}px`);
    expect(adminName).toContain(`line-height: ${styleNumber(name, "lineHeight", "reelName")}px`);
    // Colors.white on mobile; admin spells the same value as its own token.
    expect(name).toMatch(/color:\s*Colors\.white/);
    expect(adminName).toContain("color: var(--white)");

    const adminByline = adminRule(".reelByline").replace(/\s+/g, " ");
    expect(adminByline).toContain(`font-size: ${styleNumber(byline, "fontSize", "reelByline")}px`);
    expect(adminByline).toContain(
      `line-height: ${styleNumber(byline, "lineHeight", "reelByline")}px`,
    );
    const bylineAlpha = byline.match(/color:\s*withAlpha\(Colors\.white,\s*([0-9.]+)\)/);
    expect(bylineAlpha, `no alpha colour in reelByline: ${byline}`).not.toBeNull();
    expect(adminByline).toContain(`rgba(${rgbOf(colors.white)}, ${bylineAlpha![1]})`);
  });

  it("draws the reel's LABEL PILL at mobile's geometry and type", () => {
    // ENG-1438. Admin gained a pill on the scrim because mobile slots one into
    // both heads (see the structural rule above). Its NUMBERS are read out of
    // mobile for the same reason all the others are: a hand-copied pill is a
    // hand-copied pill, and this one is brand new so it has had no chance to
    // drift yet — which is exactly when to pin it.
    const pill = cardStyle("labelPill").body;
    // RAW: `alignSelf: 'flex-start'` is a string literal, so it survives only
    // in the unstripped body. The KEY is matched in the stripped one.
    const stacked = cardStyle("labelPillStacked");
    const text = cardStyle("labelPillText").body;
    const dot = cardStyle("labelDot").body;
    const { colors } = memberTokens();

    const admin = adminRule(".reelLabelPill").replace(/\s+/g, " ");
    expect(admin).toContain(`height: ${styleNumber(pill, "height", "labelPill")}px`);
    expect(admin).toContain(`gap: ${styleNumber(pill, "gap", "labelPill")}px`);
    expect(admin).toContain(
      `padding: 0 ${styleNumber(pill, "paddingHorizontal", "labelPill")}px`,
    );
    // The STACKED override is what puts it under the byline at full width.
    expect(admin).toContain(
      `margin-top: ${styleNumber(stacked.body, "marginTop", "labelPillStacked")}px`,
    );
    expect(stacked.body, "labelPillStacked no longer sets alignSelf").toMatch(/alignSelf\s*:/);
    expect(stacked.rawBody).toMatch(/alignSelf\s*:\s*'flex-start'/);
    expect(admin).toContain("align-self: flex-start");
    // The cap is mobile's too, not a number admin chose: `labelPillStacked`
    // overrides the inline chip's 62% precisely so a long title can use the
    // whole column. If mobile reverts that, admin must not stay at 100%.
    const cap = stacked.rawBody.match(/maxWidth\s*:\s*'([0-9]+%)'/);
    expect(cap, `no maxWidth in labelPillStacked: ${stacked.rawBody}`).not.toBeNull();
    expect(admin).toContain(`max-width: ${cap![1]}`);

    // Brand green ground, cream type and a cream dot — mobile's tokens, not a
    // hex admin picked.
    expect(pill).toMatch(/backgroundColor:\s*Colors\.brandGreen/);
    expect(admin).toContain("background: var(--brand-green)");
    expect(text).toMatch(/color:\s*Colors\.cream/);
    expect(admin).toContain("color: var(--cream)");

    const adminText = adminRule(".reelLabelPillText").replace(/\s+/g, " ");
    expect(adminText).toContain(`font-size: ${styleNumber(text, "fontSize", "labelPillText")}px`);
    expect(adminText).toContain(
      `letter-spacing: ${styleNumber(text, "letterSpacing", "labelPillText")}px`,
    );
    expect(adminText).toContain(
      `line-height: ${styleNumber(text, "lineHeight", "labelPillText")}px`,
    );
    // SENTENCE CASE. Justin, 26 Aug: titles are free text, and ALL-CAPS made a
    // truncated title read as shouting. `textTransform` is simply absent from
    // mobile's style now, so admin must not re-add one — and if mobile brings
    // it back, this goes red instead of leaving admin lower-case behind.
    expect(
      text,
      "mobile's label pill text regained a textTransform — admin's reel pill is sentence case",
    ).not.toMatch(/textTransform/);
    expect(adminText).not.toContain("text-transform:");

    const adminDot = adminRule(".reelLabelPillDot").replace(/\s+/g, " ");
    const dotSize = styleNumber(dot, "width", "labelDot");
    expect(adminDot).toContain(`width: ${dotSize}px`);
    expect(adminDot).toContain(`height: ${styleNumber(dot, "height", "labelDot")}px`);
    expect(dot).toMatch(/backgroundColor:\s*Colors\.cream/);
    expect(colors.cream, "mobile has no Colors.cream").toBeTruthy();
    expect(adminDot).toContain("background: var(--cream)");
  });

  it("drops the card's top padding by mobile's amount, in BOTH admin scales", () => {
    const top = styleNumber(cardStyle("reelCard").body, "paddingTop", "reelCard");
    for (const selector of [".postCardReel", ".previewCompact .postCardReel"]) {
      expect(adminRule(selector)).toMatch(new RegExp(`padding-top:\\s*${top}(px)?`));
    }
  });

  it("still draws the overlaid identity at all — mobile has not dropped it", () => {
    // M4: every rule above is about SUPPRESSION. If mobile deleted the reel
    // scrim entirely, admin would keep drawing a header the member card no
    // longer has, and nothing else here would notice.
    //
    // ENG-1438: the scrim is still the card's; the name and byline styles it
    // wraps are the HEAD's, and `variant="reel"` is what selects them. All four
    // are required — reading them from the wrong file is how this went red in
    // the first place, and a fallback search would have hidden the move.
    expect(CODE, "the card stopped drawing its reel scrim").toContain("styles.reelTopScrim");

    // WHICH VARIANTS THE CARD ASKS FOR. `variant="reel"` is a string literal,
    // so it is blanked out of CODE — but the ATTRIBUTE survives, and the raw
    // value can be read back at the same offset (see rawAt). Matching the raw
    // source directly would instead be satisfied by the prose above the JSX,
    // which discusses `variant="reel"` at length.
    const variants = [...CODE.matchAll(/variant=/g)].map((m) => {
      const raw = rawAt(cardSource(), m.index!, 40);
      const value = raw.match(/^variant=\{?["']([a-z]+)["']/);
      if (!value) {
        throw new Error(
          "THE GUARD HAS GONE BLIND: the card passes a `variant=` this guard " +
            `cannot read a literal out of: ${JSON.stringify(raw)}. It may now be ` +
            "computed, which means which head a reel gets is no longer readable here.",
        );
      }
      return value[1];
    });
    expect(
      [...variants].sort(),
      "the card no longer asks for exactly one classic head and one reel head",
    ).toEqual(["classic", "reel"]);
    expect(HEAD_CODE, "post-head.tsx no longer styles the reel name").toMatch(
      /styles\.reelName(?![A-Za-z])/,
    );
    expect(HEAD_CODE, "post-head.tsx no longer styles the reel byline").toMatch(
      /styles\.reelByline(?![A-Za-z])/,
    );
    // And the reel head is genuinely a head: it renders both lines, not just
    // the name. (`reelName`/`reelByline` are selected by the same ternary.)
    expect(HEAD_CODE).toMatch(/reel\s*\?\s*styles\.reelName\s*:/);
    expect(HEAD_CODE).toMatch(/reel\s*\?\s*styles\.reelByline\s*:/);
  });
});
