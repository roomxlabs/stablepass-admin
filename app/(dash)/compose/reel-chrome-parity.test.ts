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
 * makes the test pass", which would be no guard at all. Admin's round-6
 * preview mirrors the round-6 member card, so the integration branch is asked
 * for first; once it merges and is deleted, `origin/main` carries the same
 * rules and takes over; the working tree is the last resort for a checkout
 * with no remote.
 *
 * This ordering is load-bearing and was found the hard way: the local mobile
 * checkout sits on `main`, where ENG-750's label pill has NOT landed. Reading
 * the working tree — the obvious implementation — would have mirrored a
 * revision with no label pill at all and quietly verified nothing about the
 * rule this ticket exists to encode.
 */
const CONTRACT_REFS = ["origin/feature/round6-v1", "origin/main"] as const;

function readMemberCard(): { source: string; origin: string } | null {
  if (!MOBILE_REPO) return null;
  const rel = "src/components/post-card.tsx";

  /**
   * Only trust refs if MOBILE_REPO is the ROOT of its own git repo.
   *
   * `git -C <dir>` resolves against whatever repository CONTAINS <dir>, not
   * the directory itself. Without this check, a `stablepass-mobile` folder
   * that happens to sit inside another checkout would have its refs resolved
   * in that outer repo — asking admin's own history for a mobile file. Found
   * by mutation-testing this guard, which is exactly what it is for.
   */
  let isOwnRepo = false;
  try {
    const top = execFileSync("git", ["-C", MOBILE_REPO, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    isOwnRepo = top === MOBILE_REPO;
  } catch {
    isOwnRepo = false;
  }

  if (isOwnRepo) {
    for (const ref of CONTRACT_REFS) {
      try {
        // rev-parse proves the ref exists; `show` can still fail if the path
        // moved within that revision, so both are inside the try.
        execFileSync("git", ["-C", MOBILE_REPO, "rev-parse", "--verify", "--quiet", ref], {
          stdio: "ignore",
        });
        const source = execFileSync("git", ["-C", MOBILE_REPO, "show", `${ref}:${rel}`], {
          encoding: "utf8",
          maxBuffer: 20 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        });
        return { source, origin: `${MOBILE_REPO} @ ${ref}` };
      } catch {
        continue;
      }
    }
  }

  const path = join(MOBILE_REPO, rel);
  if (!existsSync(path)) return null;
  return { source: readFileSync(path, "utf8"), origin: `${path} (working tree)` };
}

const CARD = readMemberCard();

/** `src/theme/tokens.ts` from the SAME revision the card was read from. */
function readMemberTokens(): string | null {
  if (!MOBILE_REPO || !CARD) return null;
  const rel = "src/theme/tokens.ts";
  const ref = CARD.origin.split(" @ ")[1];
  if (ref) {
    try {
      return execFileSync("git", ["-C", MOBILE_REPO, "show", `${ref}:${rel}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      /* fall through to the working tree */
    }
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

/**
 * Index of the first match of `re` in the code, or a loud failure.
 *
 * Needed because a bare substring search is not specific enough to anchor on:
 * `styles.labelPill` also matches `styles.labelPillText`, and `styles.raceBadge`
 * also matches `styles.raceBadgeGold`. Both are SIBLINGS that stay inside the
 * head row when the thing itself moves out — so the containment assertions
 * below stayed green through a mutation that should have reddened them. Caught
 * by mutation-testing; the trailing `(?![A-Za-z])` boundaries are the fix.
 */
function codeIndexRe(re: RegExp, what: string): number {
  const m = CODE.match(re);
  if (!m || m.index === undefined) {
    throw new Error(
      `THE GUARD HAS GONE BLIND: ${what} — expected ${re} to match the member ` +
        `card's CODE (${CARD?.origin}), outside comments and strings. ` +
        "Re-derive the anchor rather than deleting the assertion.",
    );
  }
  return m.index;
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

describe("the reel CHROME rules match the member card", () => {
  /** The span of the `{isReel ? null : ( ... )}` block that holds the head. */
  function classicHeadSpan(): [number, number] {
    const at = codeIndex("isReel ? null :", "mobile's white-header-row suppression");
    return blockSpan(at, "the classic head block");
  }

  it("stands the white header row down on a reel", () => {
    const [open, close] = classicHeadSpan();
    const block = CODE.slice(open, close);
    // The suppressed block really is the head row, not some other conditional.
    expect(block, "the isReel-suppressed block is not the head row").toContain("styles.head");
  });

  it("keeps the LABEL PILL inside that head — so a reel has none by construction", () => {
    // THE RULE THIS TICKET EXISTS FOR. Asserted structurally rather than by
    // trusting the comment next to it: the pill must live INSIDE the block the
    // reel branch nulls out. If mobile ever moves the pill out of the head, a
    // reel starts showing one and admin's preview becomes wrong again — red.
    const [open, close] = classicHeadSpan();
    const pill = codeIndexRe(/styles\.labelPill(?![A-Za-z])/, "mobile's label pill");
    // EXACTLY ONE reference. Position alone only proves that *a* pill is inside
    // the head; mobile could add a SECOND pill inside the reel scrim and this
    // would stay green while admin hid the pill and told the operator it never
    // renders — the same lie, inverted. Found in review.
    expect(
      (CODE.match(/styles\.labelPill(?![A-Za-z])/g) ?? []).length,
      "mobile now references its label pill more than once — a reel may have gained one",
    ).toBe(1);
    expect(
      pill > open && pill < close,
      "mobile's label pill is no longer inside the head row that a reel suppresses — " +
        "admin's preview hides the pill on reels on the strength of that. Re-check both.",
    ).toBe(true);
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
  it("records that the race badge rides with the suppressed head", () => {
    // Not an admin rule so much as a consequence: the race badge sits inside
    // the head row, so a reel drops it too. Admin's preview matches that, and
    // it is surprising enough to be worth pinning rather than rediscovering.
    const at = codeIndex("isReel ? null :", "the head suppression");
    const [open, close] = blockSpan(at, "the classic head block");
    const badge = codeIndexRe(/styles\.raceBadge(?![A-Za-z])/, "mobile's race badge");
    expect(
      (CODE.match(/styles\.raceBadge(?![A-Za-z])/g) ?? []).length,
      "mobile now references its race badge more than once — a reel may have gained one",
    ).toBe(1);
    expect(
      badge > open && badge < close,
      "mobile's race badge left the head row — admin's preview drops it on reels " +
        "because it was inside. Re-check both.",
    ).toBe(true);
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

/** The body of one entry in the card's StyleSheet.create({...}) object. */
function memberStyle(name: string): string {
  const at = codeIndexRe(new RegExp(`\\n  ${name}:\\s*\\{`), `mobile's ${name} style`);
  const open = CODE.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < CODE.length; i++) {
    if (CODE[i] === "{") depth += 1;
    else if (CODE[i] === "}") {
      depth -= 1;
      if (depth === 0) return CODE.slice(open + 1, i);
    }
  }
  throw new Error(`THE GUARD HAS GONE BLIND: unbalanced braces in mobile's ${name}`);
}

/** A numeric style property, resolving `Spacing.*` to its token value. */
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
    const block = memberStyle("reelTopScrim");
    const top = styleNumber(block, "paddingTop", "reelTopScrim");
    const side = styleNumber(block, "paddingHorizontal", "reelTopScrim");
    const bottom = styleNumber(block, "paddingBottom", "reelTopScrim");
    const gap = styleNumber(block, "gap", "reelTopScrim");
    const scrim = adminRule(".reelScrim").replace(/\s+/g, " ");
    expect(scrim).toContain(`padding: ${top}px ${side}px ${bottom}px`);
    expect(scrim).toContain(`gap: ${gap}px`);
  });

  it("sets the overlaid name and byline at mobile's sizes and colours", () => {
    const horse = memberStyle("reelHorse");
    const byline = memberStyle("reelByline");
    const { colors } = memberTokens();

    const adminHorse = adminRule(".reelHorse").replace(/\s+/g, " ");
    expect(adminHorse).toContain(`font-size: ${styleNumber(horse, "fontSize", "reelHorse")}px`);
    expect(adminHorse).toContain(`line-height: ${styleNumber(horse, "lineHeight", "reelHorse")}px`);
    // Colors.white on mobile; admin spells the same value as its own token.
    expect(horse).toMatch(/color:\s*Colors\.white/);
    expect(adminHorse).toContain("color: var(--white)");

    const adminByline = adminRule(".reelByline").replace(/\s+/g, " ");
    expect(adminByline).toContain(`font-size: ${styleNumber(byline, "fontSize", "reelByline")}px`);
    expect(adminByline).toContain(
      `line-height: ${styleNumber(byline, "lineHeight", "reelByline")}px`,
    );
    const bylineAlpha = byline.match(/color:\s*withAlpha\(Colors\.white,\s*([0-9.]+)\)/);
    expect(bylineAlpha, `no alpha colour in reelByline: ${byline}`).not.toBeNull();
    expect(adminByline).toContain(`rgba(${rgbOf(colors.white)}, ${bylineAlpha![1]})`);
  });

  it("drops the card's top padding by mobile's amount, in BOTH admin scales", () => {
    const top = styleNumber(memberStyle("reelCard"), "paddingTop", "reelCard");
    for (const selector of [".postCardReel", ".previewCompact .postCardReel"]) {
      expect(adminRule(selector)).toMatch(new RegExp(`padding-top:\\s*${top}(px)?`));
    }
  });

  it("still draws the overlaid identity at all — mobile has not dropped it", () => {
    // M4: every rule above is about SUPPRESSION. If mobile deleted the reel
    // scrim entirely, admin would keep drawing a header the member card no
    // longer has, and nothing else here would notice.
    expect(CODE).toContain("styles.reelTopScrim");
    expect(CODE).toMatch(/styles\.reelHorse/);
    expect(CODE).toMatch(/styles\.reelByline/);
  });
});
