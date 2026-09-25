// @vitest-environment jsdom
//
// ENG-1441 — THIS FILE NOW RENDERS, as well as reads.
//
// Every rule below used to be "a value in mobile's source equals a value in
// admin's stylesheet". That covers the CSS drifts and nothing else, which is
// how three of this ticket's four findings sat unguarded: the byline's age tail
// is not a CSS fact, it is a BRANCH in PostPreview.tsx, and no amount of
// stylesheet-reading can see it. So the head-content rules below render the
// real component for all three subjects and both chromes, and compare what it
// prints to the structure read out of mobile's PostHead. jsdom costs this file
// nothing — node:fs and node:child_process work unchanged under it.
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
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import PostPreview, { POSTED_AGO, type PostPreviewData } from "./PostPreview";
import {
  ASPECT_MIN,
  REEL_ASPECT_MIN,
  isReelPreview,
  resolveAspect,
} from "./types";

afterEach(cleanup);

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
    // NO FALL-THROUGH TO THE WORKING TREE (tightened by ENG-1441). This used to
    // drop to the checkout's own copy when `show` failed at the card's ref, and
    // that is the one asymmetry left in a file whose whole discipline is "blind
    // loudly, never default": `readMemberHead` and `readMemberAvatar` both
    // return null there. Spacing, Colors, Radius and FontFamily now decide real
    // assertions, so resolving them from a DIFFERENT revision than the card
    // would compare a radius token to a card that never shipped with it.
    return showAtRef(rel, ref);
  }
  const path = join(MOBILE_REPO, rel);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

const TOKENS = readMemberTokens();

/**
 * `src/components/ui/avatar.tsx`, at the card's own revision (ENG-1441).
 *
 * THE THIRD MOBILE FILE. The head avatar's shape is split across two of them:
 * post-head.tsx owns the S-mark box (`HEAD_AVATAR_BOX`, `AVATAR_BOX_RADIUS`)
 * and delegates the photo/monogram case to `<Avatar size="row" shape="rounded">`
 * — so the 72 and the 14 that admin draws are only HALF readable from the head.
 * Pinned to the card's ref for the same reason the head is: an avatar from a
 * different revision would compare a box to a radius that never shipped with it.
 */
function readMemberAvatar(): { source: string; origin: string } | null {
  if (!MOBILE_REPO || !CARD) return null;
  const rel = "src/components/ui/avatar.tsx";
  const ref = CARD.origin.split(" @ ")[1];
  if (ref) {
    const source = showAtRef(rel, ref);
    return source === null ? null : { source, origin: `${MOBILE_REPO} @ ${ref}` };
  }
  const path = join(MOBILE_REPO, rel);
  if (!existsSync(path)) return null;
  return { source: readFileSync(path, "utf8"), origin: `${path} (working tree)` };
}

const AVATAR = readMemberAvatar();

/** ui/avatar.tsx's source, or a loud failure. Symmetrical with headSource(). */
function avatarSource(): string {
  if (!AVATAR) {
    throw new Error(
      "THE GUARD HAS GONE BLIND: found the member card " +
        `(${CARD?.origin}) but not src/components/ui/avatar.tsx at the SAME ` +
        "revision. The head's photo avatar is an `<Avatar size=\"row\" " +
        'shape="rounded">`, so its BOX and its RADIUS live in that file — ' +
        "admin's preview draws both. Re-derive the anchor, do not delete the " +
        "assertion.",
    );
  }
  return AVATAR.source;
}

const AVATAR_CODE = AVATAR ? stripNonCode(AVATAR.source) : "";

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

/**
 * `codeIndex`, for a mobile file other than the card (ENG-1441).
 *
 * The head and the avatar module needed the same "find it in the stripped code,
 * read its value out of the raw source" treatment the card already had, and a
 * second hand-rolled indexOf would have been a second chance to get the blind
 * case wrong. Same contract: throw, never return -1.
 */
function codeIndexIn(code: string, needle: string, what: string, origin?: string): number {
  const at = code.indexOf(needle);
  if (at === -1) {
    throw new Error(
      `THE GUARD HAS GONE BLIND: ${what} — expected to find \`${needle}\` in the ` +
        `CODE of ${origin}, outside comments and strings. Re-derive the anchor ` +
        "rather than deleting the assertion.",
    );
  }
  return at;
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

/**
 * `Spacing` / `Colors` / `Radius` / `FontFamily` from mobile's tokens.ts, at
 * the card's own revision.
 *
 * `Radius` and `FontFamily` were added by ENG-1441: the head avatar's corner is
 * `Radius.md` and the reel name's face is `FontFamily.sansSemiBold`, and both
 * were previously unread — admin's `border-radius: 50%` and its `font-weight`
 * were simply numbers nobody was checking.
 */
function memberTokens(): {
  spacing: Record<string, number>;
  colors: Record<string, string>;
  radius: Record<string, number>;
  fontFamily: Record<string, string>;
} {
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
  const radius: Record<string, number> = {};
  for (const m of grab("Radius").matchAll(/(\w+)\s*:\s*([0-9.]+)/g)) radius[m[1]] = Number(m[2]);
  const fontFamily: Record<string, string> = {};
  for (const m of grab("FontFamily").matchAll(/(\w+)\s*:\s*'([\w_]+)'/g)) fontFamily[m[1]] = m[2];
  return { spacing, colors, radius, fontFamily };
}

/**
 * One of mobile's `FontFamily.*` tokens, as the CSS admin has to spell.
 *
 * The tokens are loaded-font names — `Inter_600SemiBold`, `Inter_400Regular`,
 * `CormorantGaramond_600SemiBold` — because react-native picks a face by name
 * and has no numeric weight axis. The web has both, so one mobile token maps to
 * a (family, weight) PAIR here, and BOTH halves have to be asserted: admin
 * spelling `var(--font-sans)` with no weight, or weight 600 on the serif, are
 * each a real drift that reading one half alone would wave through.
 *
 * Throws on an unrecognised family rather than guessing a variable name — a new
 * mobile face is exactly the kind of change that must be re-derived by hand.
 */
function cssFaceOf(token: string): { family: string; weight: number } {
  const name = memberTokens().fontFamily[token];
  if (!name) {
    throw new Error(
      `THE GUARD HAS GONE BLIND: mobile's tokens.ts has no FontFamily.${token} ` +
        "— the face admin mirrors was renamed or removed. Re-derive it.",
    );
  }
  const weight = name.match(/_(\d{3})/);
  if (!weight) {
    throw new Error(
      `THE GUARD HAS GONE BLIND: cannot read a weight out of FontFamily.${token} ` +
        `(\`${name}\`). Admin spells this as a numeric font-weight, so the number ` +
        "has to come from mobile and not from us.",
    );
  }
  const family = name.startsWith("Inter")
    ? "var(--font-sans)"
    : name.startsWith("Cormorant")
      ? "var(--font-serif)"
      : null;
  if (!family) {
    throw new Error(
      `THE GUARD HAS GONE BLIND: FontFamily.${token} is \`${name}\`, a face this ` +
        "repo has no CSS variable for. Admin loads Inter and Cormorant via " +
        "next/font; a third face is a real design change, not a mapping to guess.",
    );
  }
  return { family, weight: Number(weight[1]) };
}

/** A style's `fontFamily: FontFamily.x` token name, or a loud failure. */
function fontToken(block: string, what: string): string {
  const m = block.match(/fontFamily\s*:\s*FontFamily\.(\w+)/);
  if (!m) {
    throw new Error(
      `THE GUARD HAS GONE BLIND: no \`fontFamily: FontFamily.*\` in ${what}. ` +
        "The face may now be inherited or computed, which means admin's weight " +
        "is no longer readable from mobile. Re-derive it.",
    );
  }
  return m[1];
}

/** Assert one admin rule carries the (family, weight) a mobile token names. */
function expectFace(selector: string, token: string, what: string): void {
  const { family, weight } = cssFaceOf(token);
  const css = adminRule(selector).replace(/\s+/g, " ");
  expect(css, `${selector} should draw ${what} in FontFamily.${token} (${family})`).toContain(
    `font-family: ${family}`,
  );
  expect(css, `${selector} should draw ${what} at FontFamily.${token}'s weight`).toContain(
    `font-weight: ${weight}`,
  );
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
      /colors=\{\[withAlpha\(Colors\.ink(?![A-Za-z]),\s*([0-9.]+)\)/,
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
    // ENG-1441 — THE FACE, not just the size. `reelName` is the one head style
    // that names its own `fontFamily` (the classic `name` spreads `Type.name`),
    // and admin had a hand-typed `font-weight: 600` beside it that nothing
    // checked: mobile could have dropped to `FontFamily.sans` and admin's reel
    // would have stayed semibold with every assertion green. That is exactly
    // the mutation this ticket's second proof runs.
    expectFace(".reelHorse", fontToken(name, "mobile's reelName"), "the reel's name");
    expectFace(".reelByline", fontToken(byline, "mobile's reelByline"), "the reel's byline");
    expect(adminName).toContain(`font-size: ${styleNumber(name, "fontSize", "reelName")}px`);
    expect(adminName).toContain(`line-height: ${styleNumber(name, "lineHeight", "reelName")}px`);
    // Colors.white on mobile; admin spells the same value as its own token.
    expect(name).toMatch(/color:\s*Colors\.white(?![A-Za-z])/);
    expect(adminName).toContain("color: var(--white)");

    const adminByline = adminRule(".reelByline").replace(/\s+/g, " ");
    expect(adminByline).toContain(`font-size: ${styleNumber(byline, "fontSize", "reelByline")}px`);
    expect(adminByline).toContain(
      `line-height: ${styleNumber(byline, "lineHeight", "reelByline")}px`,
    );
    const bylineAlpha = byline.match(/color:\s*withAlpha\(Colors\.white(?![A-Za-z]),\s*([0-9.]+)\)/);
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

    const admin = adminRule(".headLabelPill").replace(/\s+/g, " ");
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
    //
    // `(?![A-Za-z])` on every token here and above (ENG-1441): without it
    // `Colors.brandGreen` PREFIX-matches `Colors.brandGreenDark`, and mutating
    // mobile's pill to the dark green left this green — a visibly different
    // chip on the member card with the guard clean. Same for `Colors.cream` vs
    // `Colors.creamDark` and `Colors.white` vs `Colors.whiteDim`. The boundary
    // is the same one `styles\.labelPill(?![A-Za-z])` already uses a few rules
    // up; these six had simply never had it.
    expect(pill).toMatch(/backgroundColor:\s*Colors\.brandGreen(?![A-Za-z])/);
    expect(admin).toContain("background: var(--brand-green)");
    expect(text).toMatch(/color:\s*Colors\.cream(?![A-Za-z])/);
    expect(admin).toContain("color: var(--cream)");

    const adminText = adminRule(".headLabelPillText").replace(/\s+/g, " ");
    // ENG-1441 — the pill's FACE is mobile's too (`FontFamily.sansSemiBold`).
    expectFace(".headLabelPillText", fontToken(text, "mobile's labelPillText"), "the label");
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

    const adminDot = adminRule(".headLabelPillDot").replace(/\s+/g, " ");
    const dotSize = styleNumber(dot, "width", "labelDot");
    expect(adminDot).toContain(`width: ${dotSize}px`);
    expect(adminDot).toContain(`height: ${styleNumber(dot, "height", "labelDot")}px`);
    expect(dot).toMatch(/backgroundColor:\s*Colors\.cream(?![A-Za-z])/);
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

// ---------------------------------------------------------------------------
// ENG-1441 — THE HEAD ITSELF
//
// Everything above this line guards the REEL's chrome. The head that sits in it
// was almost entirely unguarded, and the independent review of admin#109 found
// three drifts hiding in that gap — a 44px circle where mobile draws a 72px
// rounded box, a byline age tail on one subject out of three, and a classic
// label chip two design generations old. All three had survived every prior
// round of this file, and all three were proved to survive it: mutating mobile
// left the suite green.
//
// So these rules read the head's shape out of mobile the way the chrome's
// values already were, and — where the rule is a BRANCH rather than a number —
// render admin's real component and read what it prints.
// ---------------------------------------------------------------------------

describe("the head AVATAR is mobile's box, not our circle", () => {
  it("found ui/avatar.tsx at the SAME revision — half the shape lives there", () => {
    // Symmetrical with the post-head.tsx check: a missing avatar module is as
    // blinding as a missing head, because `AVATAR_BOX_RADIUS` and the `row`
    // box are the two numbers admin's `.postAvatar` is made of.
    expect(AVATAR, "stablepass-mobile's ui/avatar.tsx not found — see avatarSource()").not.toBeNull();
    expect(avatarSource().length).toBeGreaterThan(500);
    expect(AVATAR!.origin).toBe(CARD!.origin);
  });

  it("draws BOTH heads at HEAD_AVATAR_BOX, with AVATAR_BOX_RADIUS corners", () => {
    // `HEAD_AVATAR_BOX` is post-head.tsx's own constant (it sizes the S-mark
    // box directly). `headConstant` is the same resolver `styleNumber` uses for
    // `HEAD_NAME_SIZE`, so a constant that stops being a plain number throws
    // rather than defaulting.
    const box = headConstant("HEAD_AVATAR_BOX");
    expect(
      box,
      "post-head.tsx no longer declares `const HEAD_AVATAR_BOX = <number>` — the " +
        "head avatar's size is admin's to guess again. Re-derive it.",
    ).toBeDefined();

    // THE PHOTO AVATAR TAKES THE SAME BOX BY A DIFFERENT ROUTE: the head asks
    // for `<Avatar size="row">` and avatar.tsx's SIZES table says what `row`
    // is. Both numbers are required to agree — if they ever stop, mobile draws
    // two different head sizes and admin cannot mirror one of them.
    const rowSize = AVATAR_CODE.match(/\brow\s*:\s*\{([^}]*)\}/);
    if (!rowSize) {
      throw new Error(
        "THE GUARD HAS GONE BLIND: no `row: { box, font }` entry in mobile's " +
          `avatar SIZES table (${AVATAR?.origin}). The head asks for size "row"; ` +
          "without that entry its box is unreadable. Re-derive the anchor.",
      );
    }
    const rowBox = Number(rowSize[1].match(/box\s*:\s*([0-9.]+)/)?.[1]);
    const rowFont = Number(rowSize[1].match(/font\s*:\s*([0-9.]+)/)?.[1]);
    expect(Number.isFinite(rowBox), `no box in SIZES.row: ${rowSize[1]}`).toBe(true);
    expect(Number.isFinite(rowFont), `no font in SIZES.row: ${rowSize[1]}`).toBe(true);
    expect(
      rowBox,
      "mobile's SIZES.row.box and post-head.tsx's HEAD_AVATAR_BOX disagree — the " +
        "photo head and the StablePass disc are now different sizes on mobile, " +
        "and admin draws one box for both",
    ).toBe(box);

    // THE HEAD REALLY ASKS FOR THE ROUNDED BOX. Without this, mobile could
    // switch `shape` back to the default circle and every NUMBER below would
    // still match while the two products drew different silhouettes.
    //
    // Found in the CODE (where a paragraph cannot forge a JSX tag) and read
    // back out of the RAW source at the same offset, because `"row"` and
    // `"rounded"` are string literals and `stripNonCode` blanks them. Exactly
    // the rawAt dance the `variant=` rule already does, and for the same reason.
    const avatarTag = codeIndexIn(HEAD_CODE, "<Avatar ", "mobile's head Avatar element", HEAD?.origin);
    expect(
      rawAt(headSource(), avatarTag, 160),
      'mobile\'s HeadAvatar stopped asking for <Avatar size="row" shape="rounded"> ' +
        "— re-read what shape the head draws before trusting the radius below",
    ).toMatch(/size=\{?["']row["']\}?[\s\S]{0,40}shape=\{?["']rounded["']\}?/);

    // ...and `rounded` really resolves to AVATAR_BOX_RADIUS rather than to
    // `box / 2`, which is the circle this drift was.
    expect(
      AVATAR_CODE,
      "mobile's Avatar no longer maps shape=rounded to AVATAR_BOX_RADIUS",
    ).toMatch(/borderRadius\s*:\s*shape\s*===\s*\s*\?\s*AVATAR_BOX_RADIUS\s*:\s*box\s*\/\s*2/);

    // The radius itself, through the token it is declared as.
    const radiusToken = avatarSource().match(
      /export const AVATAR_BOX_RADIUS\s*=\s*Radius\.(\w+)/,
    );
    if (!radiusToken) {
      throw new Error(
        "THE GUARD HAS GONE BLIND: `export const AVATAR_BOX_RADIUS = Radius.*` is " +
          `no longer in ${AVATAR?.origin}. Admin spells this corner as a literal ` +
          "px, so the token is the only thing tying the two together.",
      );
    }
    const radius = memberTokens().radius[radiusToken[1]];
    expect(radius, `mobile has no Radius.${radiusToken[1]}`).toBeDefined();

    // ADMIN. One rule serves both chromes (the reel avatar only adds a ring),
    // so the box is asserted once and the reel is checked for NOT re-rounding
    // it — a `border-radius: 50%` reintroduced on `.reelAvatar` would put the
    // circle back on exactly the screenshot this ticket came from.
    const avatar = adminRule(".postAvatar").replace(/\s+/g, " ");
    expect(avatar).toContain(`width: ${box}px`);
    expect(avatar).toContain(`height: ${box}px`);
    expect(avatar).toContain(`border-radius: ${radius}px`);
    expect(
      avatar,
      "admin's head avatar is a circle again — mobile draws a rounded BOX",
    ).not.toMatch(/border-radius:\s*50%/);
    // The monogram is sized from mobile's own SIZES.row.font for the same
    // reason: a 72px box with the old 18px initial is not the head mobile draws.
    expect(avatar).toContain(`font-size: ${rowFont}px`);

    // ...AND ITS FACE. This diff moved the monogram off Cormorant/600 onto
    // Inter/500 because mobile's `initial` style spreads `Type.name` — "the
    // initial stands in for the name, so it follows the name face" — and for a
    // while that was the one number here NOT read back out of mobile: retuning
    // `Type.name` to semibold left admin at 500 with this test green. Resolved
    // through the SPREAD rather than by spelling `sansMedium`, so mobile
    // repointing `Type.name` moves admin with it.
    const initial = styleIn(
      AVATAR_CODE,
      avatarSource(),
      "initial",
      "ui/avatar.tsx",
      AVATAR?.origin,
    ).body;
    const spread = initial.match(/\.\.\.Type\.(\w+)/);
    if (!spread) {
      throw new Error(
        "THE GUARD HAS GONE BLIND: mobile's avatar `initial` style no longer " +
          `spreads a \`Type.*\` (${AVATAR?.origin}), so the monogram's face is ` +
          "unreadable. Admin spells it as a family + weight; re-derive it.",
      );
    }
    const typeEntry = styleIn(
      stripNonCode(TOKENS ?? ""),
      TOKENS ?? "",
      spread[1],
      "tokens.ts",
      "mobile tokens.ts",
    ).body;
    expectFace(".postAvatar", fontToken(typeEntry, `mobile's Type.${spread[1]}`), "the monogram");
    expect(
      adminRule(".reelAvatar").replace(/\s+/g, " "),
      "the reel avatar re-rounds the box — both heads share one shape on mobile",
    ).not.toMatch(/border-radius/);
  });
});

// ---------------------------------------------------------------------------
// Rendering admin's head — the rules that are BRANCHES, not numbers
// ---------------------------------------------------------------------------

const PREVIEW_BASE: PostPreviewData = {
  horseName: "Mahogany",
  byline: "Chris Waller",
  caption: "Last fast gallop before Saturday.",
  mediaType: "video",
  mediaUrl: "blob:local-file",
  racesToday: false,
  dims: null,
  measure: "off",
};

/** The three subjects, each with the data its head needs. */
const SUBJECTS: { name: string; data: Partial<PostPreviewData>; secondary: string }[] = [
  { name: "horse", data: {}, secondary: "Chris Waller" },
  {
    name: "trainer",
    data: {
      subject: "trainer",
      trainer: { name: "Chris Waller", photoUrl: null, subline: "Rosehill · NSW" },
    },
    secondary: "Rosehill · NSW",
  },
  {
    name: "stablepass",
    data: { subject: "stablepass", byline: "Racing TV" },
    secondary: "Racing TV",
  },
];

/**
 * A CLASSIC card (square video) or a REEL (9:16), for one subject.
 *
 * `createElement` rather than JSX so this file stays `reel-chrome-parity.test.ts`
 * — the name every ticket, PR and comment in this chain refers to it by, and a
 * rename for one call site is churn. It is the only JSX this guard needs.
 */
function renderHead(over: Partial<PostPreviewData>, reel: boolean) {
  return render(
    createElement(PostPreview, {
      data: {
        ...PREVIEW_BASE,
        ...over,
        dims: reel ? { width: 1080, height: 1920 } : { width: 1000, height: 1000 },
      },
    }),
  );
}

describe("the byline's AGE TAIL runs on every subject, as mobile's does", () => {
  /**
   * The separator mobile prints between the secondary and the age.
   *
   * Read out of the head rather than spelled here: it is a string literal, so
   * it survives only in the RAW source (CODE blanks it), and it is the one
   * character that makes "Rosehill · NSW · just now" a sentence rather than a
   * run-on.
   */
  /**
   * The BYLINE ELEMENT's span in HEAD_CODE — the one `<Text>` that prints the
   * secondary run, the separator and the age.
   *
   * Anchored on `numberOfLines={reel`, which is the byline's own attribute and
   * appears nowhere else in the head, then widened back to the `<Text` that
   * opens it and forward to the age it closes on. Bounding the subject-gate
   * rules to this element is what keeps them pointed at the byline rather than
   * at the head at large.
   */
  function bylineSpan(): string {
    const attr = codeIndexIn(
      HEAD_CODE,
      "numberOfLines={reel",
      "mobile's byline element",
      HEAD?.origin,
    );
    const open = HEAD_CODE.lastIndexOf("<Text", attr);
    // Closed on `{below}` — the label-pill slot that follows the byline —
    // rather than on `{postedAgo}` itself. Deliberate: a span that ended AT the
    // age would go BLIND the moment the age moved, reporting "the anchor is
    // gone" for what is actually "the age is gated now". Bounding it on the
    // next sibling keeps the span readable under exactly the mutation these
    // rules exist to catch, and keeps the failure message a byline rather than
    // the whole file.
    const end = HEAD_CODE.indexOf("{below}", attr);
    if (open === -1 || end === -1) {
      throw new Error(
        "THE GUARD HAS GONE BLIND: located mobile's byline attribute but not the " +
          `<Text> around it, or the {below} slot that follows it (${HEAD?.origin}). ` +
          "The byline's shape changed; re-derive the anchor.",
      );
    }
    return HEAD_CODE.slice(open, end);
  }

  /**
   * "<mobile's separator> <admin's age>", anchored to the end of the byline.
   *
   * Both halves come from somewhere real: the separator is read out of mobile,
   * and the age is `POSTED_AGO` IMPORTED from PostPreview rather than the
   * string "just now" re-typed here — re-typing it would be a hand-copied
   * constant in the file that exists to abolish hand-copied constants.
   *
   * Both are escaped before they become a pattern. `·` needs none today, but a
   * separator that ever contained a regex metachar would otherwise quietly
   * assert something other than what mobile prints — a silent mis-assert is the
   * one failure this file may not have.
   */
  function ageTail(): RegExp {
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`${esc(separator().trim())}\\s*${esc(POSTED_AGO)}$`);
  }

  function separator(): string {
    const m = headSource().match(/\{model\.secondary\}\s*<\/Text>\s*\{('[^']*')\}/);
    if (!m) {
      throw new Error(
        "THE GUARD HAS GONE BLIND: could not read the separator mobile prints " +
          `between the byline's secondary run and its age (${HEAD?.origin}). The ` +
          "byline's shape changed; re-derive it.",
      );
    }
    return m[1].slice(1, -1);
  }

  it("mobile prints {postedAgo} OUTSIDE the secondary conditional", () => {
    // THE RULE ITSELF, and the reason admin's three-way split was wrong. The
    // age is not part of the `model.secondary ? (...) : null` branch — it
    // follows it, unconditionally — so a head with no secondary prints the age
    // alone and EVERY subject gets the tail. Nothing here is gated on
    // `model.subject`; if mobile ever does gate it, this goes red rather than
    // leaving admin's copy of the rule the accidental truth.
    //
    // Matched against the BYLINE's span, not the whole head: the received value
    // is what a reader sees when this goes red, and 500 lines of post-head.tsx
    // is not a diagnosis.
    expect(
      bylineSpan(),
      "mobile's byline no longer prints {postedAgo} straight after the secondary " +
        "conditional — the age may now be gated on who posted. Re-derive whether " +
        "it is still unconditional before changing admin's heads",
    ).toMatch(/\)\s*:\s*null\}\s*\{postedAgo\}/);

    // `postedAgo` is a REQUIRED prop of the head, not an optional one a caller
    // can withhold per subject.
    expect(
      HEAD_CODE,
      "mobile's PostHead no longer takes a required `postedAgo: string`",
    ).toMatch(/postedAgo\s*:\s*string\s*;/);

    // AND THE CARD PASSES THE SAME AGE TO BOTH HEADS.
    //
    // THIS IS THE HOLE THE RULES ABOVE LEFT, and it is this ticket's own drift
    // wearing a different hat. Everything above lives inside post-head.tsx —
    // the head prints whatever `postedAgo` it is handed, unconditionally. The
    // SUBJECT GATE can therefore be moved one level up, into the card:
    //
    //     postedAgo={post.subject === 'horse' ? post.postedAgo : ''}
    //
    // and the head's source is untouched, so every assertion above stays green
    // while a member sees the age on the horse head alone — exactly the drift
    // admin just fixed, restored invisibly. Found by mutation-testing this
    // guard, which is the only reason any of these rules are trustworthy.
    //
    // So: exactly two call sites (one per head, matching the `variant=` count
    // asserted elsewhere), the same expression in both, and that expression
    // carries no conditional and no subject test.
    const ages = [...CODE.matchAll(/postedAgo=/g)].map((m) =>
      rawAt(cardSource(), m.index!, 120).match(/^postedAgo=\{([^}]*)\}/)?.[1],
    );
    expect(
      ages.length,
      `mobile's card passes postedAgo to ${ages.length} heads; expected exactly ` +
        "two (one classic, one reel). A head that stopped receiving it shows no " +
        "age at all, and admin would keep drawing one.",
    ).toBe(2);
    for (const age of ages) {
      if (age === undefined) {
        throw new Error(
          "THE GUARD HAS GONE BLIND: the card passes a `postedAgo=` this guard " +
            `cannot read an expression out of (${CARD?.origin}). Whether the age ` +
            "is subject-gated is no longer readable here — re-derive the anchor.",
        );
      }
      expect(
        age,
        `mobile's card hands one head \`${age}\` — a CONDITIONAL age. The head ` +
          "prints whatever it is given, so a gate here is a gate on the tail, and " +
          "admin's three heads would be wrong again. Re-read which subjects get it.",
      ).not.toMatch(/\?|subject/);
    }
    expect(
      new Set(ages).size,
      `mobile's two heads are handed different ages (${[...new Set(ages)].join(" vs ")}) ` +
        "— admin draws one value in both chromes",
    ).toBe(1);

    // AND THE AGE IS NOT SUBJECT-GATED. The regex above pins the age to the
    // position straight after the conditional; this pins the only `subject`
    // test in the byline to a position BEFORE it, so the tail cannot acquire
    // one. Scoped to the byline element rather than counted file-wide: the head
    // also asks `model.subject` in `postMediaA11yLabel`, which has nothing to do
    // with this rule, and a whole-file count would go red on that instead — a
    // guard that cries at the wrong change is how anchors get deleted.
    const span = bylineSpan();
    const subjectTests = [...span.matchAll(/model\.subject/g)].map((m) => m.index!);
    expect(
      subjectTests.length,
      `mobile's byline tests model.subject ${subjectTests.length} times; only the ` +
        "green run on the classic horse head should. A second test is very likely " +
        "a gate on the age tail — re-read it before leaving admin's heads alone.",
    ).toBe(1);
    const closes = span.indexOf(") : null}");
    expect(closes, "could not find the end of the secondary conditional").toBeGreaterThan(-1);
    expect(
      subjectTests[0],
      "mobile's byline now tests model.subject AFTER the secondary conditional — " +
        "the age tail may be gated on who posted, which is the drift admin just fixed",
    ).toBeLessThan(closes);
  });

  for (const { name, data, secondary } of SUBJECTS) {
    it(`admin's CLASSIC ${name} head ends its byline with the age`, () => {
      renderHead(data, false);
      const sub = screen.getByTestId("preview-head-sub").textContent ?? "";
      // The secondary is still there...
      expect(sub, `the ${name} head lost its secondary run`).toContain(secondary);
      // ...and the age closes the line, after mobile's separator.
      expect(
        sub,
        `admin's ${name} head prints "${sub}" where a member sees the age tail`,
      ).toMatch(ageTail());
    });

    it(`admin's REEL ${name} head ends its byline with the age`, () => {
      renderHead(data, true);
      // The reel head is the one the ticket's screenshot caught: a trainer reel
      // read "Chris Waller Racing · Rosehill, NSW" with no age at all.
      const scrim = screen.getByTestId("preview-reel-head");
      const sub = scrim.textContent ?? "";
      expect(sub, `the ${name} reel head lost its secondary run`).toContain(secondary);
      expect(
        sub,
        `admin's ${name} reel head prints "${sub}" where a member sees the age tail`,
      ).toMatch(ageTail());
    });
  }
});

describe("the reel byline is ONE line; the classic one is not", () => {
  it("mirrors mobile's numberOfLines={reel ? 1 : undefined}", () => {
    // A TWO-SIDED RULE, which is why it is asserted as a ternary and not as
    // "the reel byline has numberOfLines". Mobile caps the reel at one line
    // because it sits on a scrim beside a Follow pill, and deliberately leaves
    // the classic byline unlimited. Admin spells the cap as nowrap + ellipsis,
    // so BOTH halves have to be checked or a nowrap creeping onto the classic
    // byline would silently truncate a line mobile wraps.
    expect(
      HEAD_CODE,
      "mobile's byline no longer caps the REEL at one line — re-derive whether " +
        "admin should still clip it",
    ).toMatch(/numberOfLines=\{reel\s*\?\s*1\s*:\s*undefined\}/);

    const reelByline = adminRule(".reelByline").replace(/\s+/g, " ");
    expect(reelByline).toContain("white-space: nowrap");
    expect(reelByline).toContain("text-overflow: ellipsis");
    expect(reelByline).toContain("overflow: hidden");

    expect(
      adminRule(".postByline").replace(/\s+/g, " "),
      "admin's CLASSIC byline is clipped to one line; mobile leaves it unlimited",
    ).not.toContain("white-space: nowrap");
  });
});

describe("ONE label pill, stacked under the byline, on BOTH admin heads", () => {
  // The structural half ("mobile slots renderLabelPill into both heads") is
  // asserted further up. This is admin's side of it: before ENG-1441 the
  // classic head drew a DIFFERENT pill — `.labelPill`, uppercase, 10.5px, above
  // the name — and nothing compared the two, so admin's own two chromes
  // disagreed as loudly as admin and mobile did.
  it("draws the same pill markup in both chromes", () => {
    for (const reel of [false, true]) {
      cleanup();
      renderHead({ label: "Trackwork" }, reel);
      const pill = screen.getByTestId(reel ? "preview-reel-label" : "preview-label");
      expect(pill.textContent).toBe("Trackwork");
      // ONE class, and it is the head pill's.
      //
      // Vitest HASHES CSS-module keys (`_headLabelPill_7bdfe3`), so the class is
      // matched by the key it contains rather than compared literally — found by
      // running this, which is why the value is not spelled out here.
      //
      // The COUNT is the load-bearing half: the classic chip used to be
      // `.pill .pillDot .labelPill`, i.e. the dashboard's status-chip treatment
      // with an override on top, and mobile's head draws no such thing. A pill
      // that grew a second class again would be that chip coming back.
      const classes = pill.className.split(/\s+/).filter(Boolean);
      expect(
        classes.length,
        `a head's label pill carries ${classes.length} classes (${pill.className}) — ` +
          "mobile builds one pill from one style; the extras are the dashboard's " +
          "status-chip treatment creeping back in",
      ).toBe(1);
      expect(classes[0]).toMatch(/headLabelPill/);
      // The dot is a real element, as it is on mobile (`labelDot`), not a
      // `::before` glyph borrowed from `.pillDot`.
      expect(pill.querySelector("span[aria-hidden]")).not.toBeNull();
    }
  });

  it("stacks the pill AFTER the byline in both chromes", () => {
    // Mobile's `labelPillStacked` closes the head's column, under the byline.
    // Asserted structurally rather than by CSS, because "above the name" was a
    // DOM-order fact in this file, not a style one.
    renderHead({ label: "Trackwork" }, false);
    const sub = screen.getByTestId("preview-head-sub");
    const pill = screen.getByTestId("preview-label");
    expect(
      sub.compareDocumentPosition(pill) & Node.DOCUMENT_POSITION_FOLLOWING,
      "admin's classic label pill is back above the name — mobile stacks it under the byline",
    ).toBeTruthy();

    cleanup();
    renderHead({ label: "Trackwork" }, true);
    const reelHead = screen.getByTestId("preview-reel-head");
    const reelPill = screen.getByTestId("preview-reel-label");
    expect(
      reelHead.textContent?.endsWith("Trackwork"),
      "admin's reel label pill no longer closes the head stack",
    ).toBe(true);
    expect(reelPill).toBeTruthy();
  });
});

describe("a trainer photo that fails to load falls back to the initial", () => {
  it("swaps the broken <img> for the monogram", () => {
    // ENG-1441 finding 4: `e2e/__screenshots__/eng769/06-reel-trainer.png`
    // showed the browser's broken-image glyph in the head, because the only
    // fallback was the `photoUrl === null` branch and a signed URL can expire.
    renderHead(
      {
        subject: "trainer",
        trainer: { name: "Chris Waller", photoUrl: "https://x/gone.jpg", subline: "Rosehill · NSW" },
      },
      true,
    );
    const photo = screen.getByTestId("preview-avatar-photo");
    const img = photo.querySelector("img")!;
    expect(img).not.toBeNull();

    // jsdom never loads the image, so fire the event the browser would.
    fireEvent.error(img);

    expect(
      screen.queryByTestId("preview-avatar-photo"),
      "a dead trainer photo still leaves a broken <img> in the head",
    ).toBeNull();
    expect(screen.getByTestId("preview-avatar-initial").textContent).toBe("C");
  });
});
