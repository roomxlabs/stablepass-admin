// ENG-558's card-parity acceptance criteria are CSS facts ("no border", "sans",
// "no brand green behind media"). Vitest stubs CSS modules — `styles.postCard`
// is just the string "postCard" and getComputedStyle sees nothing — so a render
// test can NEVER prove any of them; all four could be reverted with the suite
// green. Read the stylesheet and assert on the rule text instead.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// process.cwd(), not import.meta.url: under Vitest import.meta.url is not a
// file: URL and readFileSync dies with "The URL must be of scheme file".
const CSS = readFileSync(join(process.cwd(), "app/(dash)/compose/compose.module.css"), "utf8");

/**
 * The declarations inside one top-level rule block.
 *
 * Rejects a DUPLICATE selector rather than reading the first and stopping.
 * Reading only the first match is not a guard at all: appending
 * `.postCard { border: 1px solid var(--line); }` to the end of the stylesheet
 * silently undoes this ticket's parity fixes with every test still green,
 * because the later rule is what the cascade actually applies. ENG-611 is
 * sequenced straight after ENG-558 and declares this same stylesheet in its
 * surface, so that is a live hazard, not a hypothetical one.
 */
function rule(selector: string): string {
  const marker = `${selector} {`;
  // Only TOP-LEVEL occurrences count: the selector has to begin its own line.
  // Without that anchor a descendant rule such as `.previewCompact .postCard {`
  // contains `.postCard {` as a substring and reads as a redeclaration, which
  // it is not — it is a different selector at a different specificity, and the
  // compact scale legitimately needs it.
  const hits: number[] = [];
  for (let i = CSS.indexOf(marker); i !== -1; i = CSS.indexOf(marker, i + 1)) {
    if (i === 0 || CSS[i - 1] === "\n") hits.push(i);
  }
  expect(hits.length, `${selector} should be declared exactly once in compose.module.css`).toBe(1);
  return CSS.slice(hits[0], CSS.indexOf("}", hits[0]));
}

describe("member-card parity (ENG-554 geometry)", () => {
  it("gives the preview card no border", () => {
    expect(rule(".postCard")).toMatch(/border:\s*none/);
    expect(rule(".postCard")).not.toMatch(/border:\s*1px/);
  });

  it("runs the media flush to the card edges", () => {
    // The card has zero HORIZONTAL padding; the gutter lives on the children,
    // which is what lets the media box reach both edges.
    expect(rule(".postCard")).toMatch(/padding:\s*18px\s+0/);
    expect(rule(".postHead")).toMatch(/margin:\s*0\s+18px/);
    expect(rule(".postBody")).toMatch(/margin:\s*12px\s+18px\s+0/);
    // ...and the media itself carries no horizontal margin or padding.
    expect(rule(".postMedia")).not.toMatch(/margin-(left|right)/);
    expect(rule(".postMedia")).not.toMatch(/padding/);
  });

  it("puts a neutral ground behind unpainted media, never brand green", () => {
    expect(rule(".postMedia")).not.toContain("--brand-green-dark");
    expect(rule(".postMedia")).toMatch(/background:\s*#1a1a1a/i);
  });

  it("keeps 16/10 as the CSS fallback so the box is never 0-height", () => {
    expect(rule(".postMedia")).toMatch(/aspect-ratio:\s*16\s*\/\s*10/);
    expect(rule(".postMedia")).not.toMatch(/aspect-ratio:\s*16\s*\/\s*9/);
  });
});

describe("option D typography on the horse name", () => {
  it("is Inter 500 on #3A3A38, not Cormorant", () => {
    const postHorse = rule(".postHorse");
    expect(postHorse).toMatch(/font-family:\s*var\(--font-sans\)/);
    expect(postHorse).toMatch(/font-weight:\s*500/);
    expect(postHorse).toMatch(/color:\s*#3a3a38/i);
    expect(postHorse).not.toContain("--font-serif");
  });
});

describe("the reaction bar exists as a styled row", () => {
  it("ships .postActions with the bookmark pushed to the far edge", () => {
    expect(rule(".postActions")).toMatch(/display:\s*flex/);
    expect(rule(".postActionSpacer")).toMatch(/flex:\s*1/);
  });
});

describe("the fake web pane is gone from the stylesheet too", () => {
  it("drops the device-frame rules the two-pane modal needed", () => {
    for (const dead of [
      ".frames {",
      ".frameLabel {",
      ".phone {",
      ".phoneScreen {",
      ".web {",
      ".webChrome {",
      ".webDots {",
      ".webUrl {",
      ".webScreen {",
    ]) {
      expect(CSS, `${dead} should have been deleted with the web pane`).not.toContain(dead);
    }
  });

  it("drops the hand-rolled mini card that duplicated the member card", () => {
    for (const dead of [".miniCard {", ".miniHead {", ".miniMedia {", ".miniBody {"]) {
      expect(CSS, `${dead} should have been replaced by <PostPreview compact>`).not.toContain(dead);
    }
  });
});

// ENG-611. Same reasoning as the block above, for the post-type picker: the
// selected state is pure CSS, so a render test cannot prove any of it. Without
// these, the entire `.typeOptionSelected` body could be deleted and all of
// vitest plus both e2e specs would stay green — the picker would render as four
// identical grey tiles with no selected state and nothing would fail.
//
// The values are the mockup's own (`.type-picker` in
// 06-stage1-design/mockups/web/style.css), so this is a fidelity guard, not a
// restatement of arbitrary numbers.
describe("post-type picker fidelity (ENG-611)", () => {
  it("is a 4-column grid with the mockup's 8px gutter", () => {
    const picker = rule(".typePicker");
    expect(picker).toMatch(/grid-template-columns:\s*repeat\(4,\s*1fr\)/);
    expect(picker).toMatch(/gap:\s*8px/);
  });

  it("draws each option as the mockup's tokened card", () => {
    const option = rule(".typeOption");
    expect(option).toMatch(/background:\s*var\(--white\)/);
    expect(option).toMatch(/border:\s*1px solid var\(--line\)/);
    expect(option).toMatch(/border-radius:\s*var\(--radius-sm\)/);
    expect(option).toMatch(/padding:\s*12px\s+8px/);
    expect(option).toMatch(/color:\s*var\(--muted\)/);
    // Tokens, never eyeballed hex.
    expect(option).not.toMatch(/#[0-9a-f]{3,6}/i);
  });

  it("gives the selected option brand green, a soft fill and the inset ring", () => {
    const selected = rule(".typeOptionSelected");
    expect(selected).toMatch(/border-color:\s*var\(--brand-green\)/);
    expect(selected).toMatch(/background:\s*var\(--brand-green-soft\)/);
    expect(selected).toMatch(/color:\s*var\(--brand-green\)/);
    expect(selected).toMatch(/font-weight:\s*600/);
    expect(selected).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--brand-green\)/);
    expect(selected).not.toMatch(/#[0-9a-f]{3,6}/i);
  });

  it("keeps the hidden radio focusable rather than display:none", () => {
    // opacity/pointer-events, NOT display:none — a display:none radio leaves
    // the group unreachable by keyboard and absent from the a11y tree.
    const input = rule(".typeOption input");
    expect(input).toMatch(/opacity:\s*0/);
    expect(input).not.toMatch(/display:\s*none/);
    // ...and the focus ring that makes that reachability visible.
    expect(rule(".typeOption:focus-within")).toMatch(/outline:\s*2px solid var\(--brand-green\)/);
  });

  it("sizes voice's audio preview to the control instead of the 360px media ground", () => {
    // A voice post has no picture; the shared .preview ground would wrap a 54px
    // native control in a 360px black rectangle.
    const audio = rule(".previewAudio");
    expect(audio).toMatch(/height:\s*auto/);
    expect(audio).not.toMatch(/#1a1a1a/i);
  });
});

// ENG-745. Two CSS facts this ticket now DEPENDS on, neither of which any
// render test can see (Vitest stubs CSS modules — see the header above).
//
// The horse picker stopped truncating its list at 8, which is only safe
// because `.results` is a scroll box: without the max-height it becomes an
// unbounded list that runs off the bottom of the panel on a 20-horse stable,
// and the ticket's "all horses reachable" acceptance criterion quietly stops
// being true. The scroll box already existed — that is exactly why it is worth
// pinning, because "it was already there" is how it gets deleted as unused.
describe("horse picker scrolls rather than truncates (ENG-745)", () => {
  it("keeps the results list a bounded scroll box", () => {
    const results = rule(".results");
    expect(results).toMatch(/max-height:\s*\d+px/);
    expect(results).toMatch(/overflow-y:\s*auto/);
  });
});

describe("the caption counter has no over-limit state (ENG-745)", () => {
  it("no longer ships a .counterOver rule", () => {
    // The 240-character cap is gone, so there is no "over" to be in. The rule
    // is deleted rather than left orphaned: left behind, the next person to
    // touch the counter re-wires a red state to a limit that no longer exists.
    expect(CSS, ".counterOver should have gone with the caption cap").not.toContain(".counterOver");
  });

  it("keeps the plain counter styling", () => {
    const counter = rule(".counter");
    expect(counter).toMatch(/font-variant-numeric:\s*tabular-nums/);
    // A count that changes on every keystroke must not reflow the label row.
    expect(counter).toMatch(/flex-shrink:\s*0/);
  });
});

// ENG-769. The reel treatment is ENTIRELY CSS — an overlaid header on an ink
// scrim, with the white header row gone. A render test can prove `data-chrome`
// flips (PostPreview.test.tsx does), but not that the scrim, the light-on-dark
// type or the removed padding actually exist. Without these the whole visual
// half of this ticket could be reverted with every other suite green.
//
// The values are the member card's own (stablepass-mobile
// `src/components/post-card.tsx`: reelTopScrim / reelHorse / reelByline,
// Spacing.lg/xl = 16/20px, Colors.ink #1A1A1A at 55%), so this is a fidelity
// guard rather than a restatement of arbitrary numbers.
describe("reel chrome fidelity (ENG-769)", () => {
  it("overlays the header on an ink scrim at the top of the frame", () => {
    const scrim = rule(".reelScrim");
    expect(scrim).toMatch(/position:\s*absolute/);
    expect(scrim).toMatch(/top:\s*0/);
    // Ink at 55%, fading to transparent — mobile's LinearGradient.
    expect(scrim).toMatch(/linear-gradient\(\s*to bottom,\s*rgba\(26,\s*26,\s*26,\s*0\.55\)/);
    expect(scrim).toMatch(/transparent/);
    // The video underneath is click-to-play in the modal.
    expect(scrim).toMatch(/pointer-events:\s*none/);
  });

  it("sets the overlaid identity light-on-dark", () => {
    expect(rule(".reelHorse")).toMatch(/color:\s*#fff/i);
    expect(rule(".reelHorse")).toMatch(/font-family:\s*var\(--font-sans\)/);
    expect(rule(".reelByline")).toMatch(/color:\s*rgba\(255,\s*255,\s*255,\s*0\.85\)/);
  });

  it("drops the card's top padding, since no header row sits above the frame", () => {
    // Mobile's `reelCard: { paddingTop: 0 }`.
    expect(rule(".postCardReel")).toMatch(/padding-top:\s*0/);
  });

  it("draws the label pill in brand green with cream type", () => {
    const pill = rule(".labelPill");
    expect(pill).toMatch(/background:\s*var\(--brand-green\)/);
    expect(pill).toMatch(/color:\s*var\(--cream\)/);
    expect(pill).toMatch(/text-transform:\s*uppercase/);
    // Tokens, never eyeballed hex.
    expect(pill).not.toMatch(/#[0-9a-f]{3,6}/i);
  });

  it("styles the note that explains a dropped label as a note, not an error", () => {
    const note = rule(".previewReelNote");
    expect(note).toMatch(/color:\s*var\(--muted\)/);
    // Never red: the label is not a mistake, it just will not render here.
    expect(note).not.toMatch(/var\(--danger\)|#c0392b|red/i);
  });
});
