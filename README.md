# ENG-611 — screenshots for PR #40

Compose gains an explicit post-type selector (Step 2), plus text and voice posts.

Captured with the repo's Playwright harness against `next start` (never `next dev` — client
screens are inert under the dev server), backed by the mock Supabase server. Seeded fixtures
only: no client data, and the voice clip is a synthetic silent WAV generated in-process.

## after/

| File | What it shows |
| --- | --- |
| `15-compose-type-picker.png` | **The selector.** Four options as Step 2, Video selected by default; steps renumbered 1 Attribute / 2 Post type / 3 Media / 4 Words. |
| `15-compose-type-mismatch.png` | A `.jpg` picked while **Video** is chosen: an error naming both sides, and the post stays a Video post. Sniffing validates, it never reclassifies. |
| `16-compose-text.png` | **A text compose.** Step 3 Media is gone entirely (2 jumps to 4), the body is required (`Body *`), Media reads "None — text post". |
| `16-compose-text-preview.png` | The preview modal for that text post. |
| `17-compose-voice.png` | **A voice compose.** `accept="audio/*"`, a playable local preview sized to the control, "uploaded" against `post-media`. |
| `04-compose-empty.png` | The empty screen, for comparison with `before/`. |
| `05-compose-filled.png` | A photo compose, now with Photo explicitly chosen. |

## before/

The same two screens on `feature/feedback-v5` (commit 4828a11) — no post-type control at all;
the type was inferred from the picked file's MIME, which is why a text post had no path.

## Known, deliberately not fixed here

- The right-rail preview still draws an empty media box for **text and voice**. `PostPreview.tsx`
  is ENG-558's file and this ticket is scoped out of it. Verified it does not crash; follow-up
  belongs to A1's owner and should be scoped "medialess **and voice**", not text alone.
- The drop zone's title/subtitle/button render on one run-together line. Pre-existing on the base
  branch — visible in `before/04-compose-empty.png`. Root cause: `.dropTitle`/`.dropSub` are inline
  spans with no `display: block`.
