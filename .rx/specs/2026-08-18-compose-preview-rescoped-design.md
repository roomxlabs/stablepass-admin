# Compose preview — real aspect + member-card parity + orientation readout (ENG-558, re-scoped)
Epic ENG-603 (round 5) · Base `feature/feedback-v5` · Supersedes PR #36, which targeted `main` and
implemented the 12 Aug scope only. Full spec in Linear.
Surface: `app/(dash)/compose/{PostPreview,PreviewModal,ComposeScreen,page,types,data}.{tsx,ts}`,
`compose.module.css`, `e2e/compose.spec.ts`.

## Why it was re-scoped
The preview's own header comment claims it shows "exactly what a subscriber will see". The round 5
grill found it lying in five ways: the same component rendered in both modal panes (so the "Web"
pane was decoration), a hardcoded `Race day` badge, no reaction bar or bookmark, the caption above
the reactions instead of below, and a raw ALL-CAPS racing name. On top of that the media box was a
fixed `aspect-ratio: 16/9` with `object-fit: cover`, so a 9:16 reel previewed as landscape with
nothing on screen to say it would be cropped (Justin, 11 Aug, complaint #3).

## Shape
One `PostPreview`, rendered twice — the always-mounted sidebar rail (`compact`) and the modal — so
the two placements can never drift into two different cards again. The rail owns measurement; the
modal only displays. Decision (b): the fake web pane is deleted and replaced by the sentence
"This is the member card. Web renders the same content in a wider column." A third faithful copy of
the member card (option a) was rejected as a standing maintenance tax.

## Geometry
Measured client-side off the picked file before any upload: `videoWidth`/`videoHeight` on
`loadedmetadata`, `naturalWidth`/`naturalHeight` on `load`. `resolveAspect` clamps to
min 0.8 (4:5) / max 1.91 (1.91:1), unknown → 1.6 (16:10), applied as an inline `aspect-ratio` over a
`16/10` CSS fallback so the box is never 0-height and never flashes a wrong orientation. The clamp
numbers are deliberately restated here rather than imported from mobile (ENG-554 holds the matching
rule) — separate codebases, and a cross-repo reference is how the two card copies drifted.

**Photos always draw at 16:10.** A photo has no Mux asset, so it has no `aspect_ratio`, so the member
app renders it in the unknown-ratio box by construction. Drawing a photo at its own ratio would put
the box in direct contradiction with the readout above it. The readout still prints the measured
dimensions, and says "cropped to 16:10" when the real ratio is more than 0.05 off.

## Readout
`.previewReadout`, built from the form's hint treatment per the mockup's `.preview-readout`
(11.5px / 500 / `--muted` / tabular-nums). `MeasureState` is `off | measuring | done`: **`off` is
load-bearing.** In edit mode the source is a Mux HLS rendition and hls.js starts low-bitrate, so
`videoWidth` reports the rendition (e.g. 640×360 for a 1080p asset). Printing that is worse than
printing nothing, so only a locally-picked file is ever measured.

## Race badge
Real data. `page.tsx` reads today's races (`race_date` = today in `Australia/Sydney`, matching the
existing `race_horse(horse_id)` embed in `lib/dashboard/queries.ts`) and marks each `HorseOption`.
Both `upcoming` and `finished` count — a horse that ran this morning still had a race day. A **failed**
race read is logged and suppresses badges; it is never silently read as "nobody races today". The
row→option mapping lives in `data.ts` (same split as `app/(dash)/trainers/data.ts`) precisely so the
badge is provably data-driven: a hardcoded value inside `page.tsx` would sail through the whole suite.

## Race badge treatment
`.pill .pillGreen .pillDot` — the classes already in `compose.module.css`, matching the mockup's
`<span class="pill green dot">` and the Status chip on the same screen. `.raceBadge` adds only the
mockup's inline `font-size: 10.5px` and `flex-shrink: 0`. It must NOT carry its own ground, weight,
case or padding: an earlier cut did, which put two design languages for one component on one screen.

## Video controls
The rail is never playable (the native control bar plus its black band eats ~40% of that small box).
The modal is playable on click, but `controls` only appears once playback starts — the bar is opaque
and covers ~21% of a 16:9 box, which is precisely the bottom edge this ticket exists to reveal. The
considered look is the one that most needs an unobstructed frame.

## Typography
Option D on the horse name: `var(--font-sans)` 500 on `#3A3A38`, matching mobile M1 and web W2. The
colour is a literal on purpose — it is this repo's CSS, not an import of mobile's token. Card geometry
locks with ENG-554: no border, no radius, media flush to the card edges (gutter on the children, not
as card padding), neutral `#1a1a1a` ground instead of `--brand-green-dark`.

## Guardrails held
No watermark is baked in — the design source `05-explore.html` does render one, deliberately not
copied; pinned by a test. No Mux URL constructed, stored or logged. No owner PII. No new route,
endpoint or data path that renders compose state without the AAL2 gate. Posting mechanics untouched:
no change to draft creation, the direct upload, scheduling or publish.
