# ENG-747 screenshots — portrait-video compose preview

PR: https://github.com/roomxlabs/stablepass-admin/pull/43

Verdict: **REOPENED** (the preview still cropped) and fixed.

The clip is a synthetic webm recorded in-page at exactly 1080x1920 (no real client footage ever
reaches a PR screenshot). It paints **corner ticks, a centre cross and its own size**, so a crop is
self-evident in a still.

| | readout | corner ticks | preview panel |
|---|---|---|---|
| `before/` | "Members see it **cropped to 4:5**" | top + bottom ticks **cut off** | 420x820 |
| `after/`  | "Members see it **as a reel at 9:16**" | **all four visible** | 420x1028 |

The panel grows 208px because the media box goes from 4:5 to a true 9:16, matching the member reel
card (stablepass-mobile @ 0d3d7da, `src/components/post-card.tsx`).

- `compare/08-portrait-modal-before-after.png` — labelled side by side, the quickest read
- `before/`, `after/` — the raw e2e captures (`08-compose-portrait{,-modal}.png`)

Captured by `e2e/compose.spec.ts` -> "compose: a portrait file previews at its real aspect with a
readout", which now also asserts the reel copy, the ABSENCE of the old copy, and a computed
`aspect-ratio: 0.5625 / 1`.
