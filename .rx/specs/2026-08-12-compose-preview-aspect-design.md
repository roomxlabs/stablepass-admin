# Compose preview: real aspect, member-card parity, orientation readout

**Ticket:** ENG-558 (epic ENG-553) · **Repo:** stablepass-admin · **Base branch:** `main`
**Grilled:** 12 Aug 2026.

## Context

Justin Alpar, 11 Aug 2026, complaint #3: "posting as reel wanted to show as landscape — problems identifying
reel 9:16 vs video 16:9."

Part of that complaint lives in the **admin UI**, not the app. `app/(dash)/compose/compose.module.css:751`
hardcodes:

```css
.postMedia {
  background: var(--brand-green-dark);
  aspect-ratio: 16/9;
  overflow: hidden;
}
.postMedia img, .postMedia video { object-fit: cover; }
```

So the operator previews **every** asset in a fixed 16:9 frame with a blind centre crop — a different fixed
box from the app's (which squares it), and neither is the truth. The word "aspect" appears exactly once in
the whole admin app, in that line. `MediaType` is only `"video" | "photo"`; nothing records or displays
orientation. An operator uploading a 9:16 reel sees it cover-cropped to 16:9 with no way to tell what members
will get.

The preview has also drifted from the member card twice over: `.postHorse` is still `var(--font-serif)`
although mobile moved horse names to Inter in ENG-419, and `.postCard` has a border + radius that ENG-554 is
removing from the member card.

**Posting mechanics do not change.** The operator still creates a draft and PUTs bytes straight to the Mux
one-time upload URL; `passthrough = post.id`; the webhook writes `aspect_ratio` (ENG-557). No new compose
field, no change to `POST /api/admin/posts`, no BFF change.

## Scope decisions (locked)

1. **Measure the selected file client-side**, before any upload: `videoWidth`/`videoHeight` on the `<video>`'s
   `loadedmetadata`, `naturalWidth`/`naturalHeight` on the `<img>` for photos.
2. **Preview at the same clamped ratio members will see.** Identical rule to ENG-554, **restated in full**
   rather than referenced — these are two independent codebases and a cross-reference is how they drift:
   min **0.8** (4:5), max **1.91** (1.91:1), unknown → **1.6** (16:10), `object-fit: cover` throughout.
3. **Print what was detected** above the preview — raw dimensions, orientation name, and what members get:
   - `1920×1080 · Landscape 16:9 · Members see it at 16:9`
   - `1080×1920 · Portrait 9:16 · Members see it cropped to 4:5`
   - `1080×1080 · Square 1:1 · Members see it at 1:1`
   - unmeasurable → `Dimensions unavailable · Members see it at 16:10`
4. **Card parity**: drop `.postCard`'s `border` and `border-radius`, media flush to the card edges,
   `.postHorse` to the sans stack. `max-width: 560px` and the centred layout stay — this is a desktop preview
   pane, not a phone.
5. **Neutral media background.** `--brand-green-dark` becomes the same neutral dark the app is adopting, so
   the preview does not show a green frame the member will never see.

IN: measurement, the clamped preview box, the readout, card parity.
OUT: upload, draft creation, the BFF, `MediaType`, scheduling, writing aspect from admin (ENG-557 owns capture).

## Surface

```
app/(dash)/compose/PostPreview.tsx        measured ratio + readout
app/(dash)/compose/ComposeScreen.tsx      lift measured dimensions into state
app/(dash)/compose/compose.module.css     .postMedia, .postCard, .postHorse, readout
app/(dash)/compose/types.ts               MediaDimensions
app/(dash)/compose/__tests__/…            unit + render tests
e2e/…compose…                             if an existing spec asserts the box
```

Do-NOT-touch: `app/api/admin/posts/**`, `HlsVideo.tsx` playback wiring, `app/(dash)/horses/`,
`app/(dash)/trainers/`.

## Migration

None — this repo has no migrations; the column is ENG-557's.

## Behaviour / contract

Pure client-side. No request shape changes.

```ts
export type MediaDimensions = { width: number; height: number } | null;

export const ASPECT_MIN = 0.8;
export const ASPECT_MAX = 1.91;
export const ASPECT_DEFAULT = 1.6;

export function resolveAspect(dims: MediaDimensions): number {
  if (!dims || !(dims.width > 0) || !(dims.height > 0)) return ASPECT_DEFAULT;
  return Math.min(ASPECT_MAX, Math.max(ASPECT_MIN, dims.width / dims.height));
}

export function describeOrientation(dims: MediaDimensions): string;
```

- **video** — `onLoadedMetadata`, read `videoWidth`/`videoHeight`.
- **photo** — `onLoad`, read `naturalWidth`/`naturalHeight`.
- Works on a local `blob:`/object URL as well as a signed HLS source, so it applies before upload.
- Apply the resolved number as an inline `aspect-ratio` on `.postMedia`, overriding the CSS default. Keep
  `16/10` as the CSS fallback so the box is never 0-height while metadata loads.

## Design

The member post card, which this preview mirrors. `PostPreview.tsx`'s own header comment already states the
intent — *"The member post card, duplicated in the admin repo so Compose can preview exactly what a subscriber
will see."* This ticket makes that true again.

Member reference: `screens/05-explore.html` `.post`, plus ENG-554's locked geometry (no card border/radius,
media flush, neutral media background), at `<workspace>/06-stage1-design/mockups/screens/`.

There is no admin-specific mockup and none is needed — the preview's job is to look like the member card, and
that card's design source is the one above. The readout line is admin chrome with no member equivalent; build
it from the existing compose form's label/hint styles rather than inventing a treatment.

## States & edge cases

- No file — existing `Media preview` empty block at the 16:10 default. No readout.
- Metadata pending — 16:10 fallback, readout `Measuring…`. Must not flash a wrong orientation.
- Metadata never loads (corrupt file, undecodable codec) — `Dimensions unavailable · Members see it at 16:10`.
  Advisory only; never blocks posting.
- **Portrait beyond 4:5** — box clamps to 0.8, readout says members see it cropped. The single most important
  case: it is the one the operator currently cannot see at all.
- Ultra-wide beyond 1.91:1 — clamps, readout says cropped.
- **Photo** — measured and previewed the same way, **but** members render photos at 16:10 regardless (no Mux
  asset ⇒ no `aspect_ratio`), so the readout must say `Members see it at 16:10`, not the measured ratio. Do not
  let the preview promise something the app will not do.
- File swapped — dimensions reset to null before the new measurement lands, so no stale readout.

## Guardrails

- **Admin access requires AAL2 (TOTP), enforced in Postgres.** Compose sits behind it; add no path that renders
  compose state without a session, and never treat empty results as "no data".
- **No owner PII.** Horse + trainer byline only.
- **No watermarking in admin.** `PostPreview`'s comment records it — the overlay is applied member-side at
  display time. Do not "improve" preview fidelity by baking it in.
- **Video via Mux signed URLs only.** The preview plays a signed HLS source or a local file; construct, store
  or log no Mux URL, and add no public asset path.
- **Content is admin-gated** — the draft→published flow is untouched.
- **Secrets from env** — no keys in client code.

## Acceptance criteria

- [ ] A 1920×1080 video previews in a 16:9 box, uncropped, with `1920×1080 · Landscape 16:9 · Members see it
      at 16:9`.
- [ ] A 1080×1920 video previews at 4:5 with `Portrait 9:16 · Members see it cropped to 4:5`.
- [ ] A square video previews at 1:1.
- [ ] A photo shows measured dimensions but says members see it at 16:10.
- [ ] With no file, the empty block renders at 16:10 with no readout.
- [ ] The preview card has no border, no radius, media flush to the card edges, horse name in sans.
- [ ] No `--brand-green-dark` behind unpainted media.
- [ ] Draft creation, the Mux upload and the publish flow are unchanged.
- [ ] Before/after screenshots with a landscape and a portrait file on the PR.

## Tests (the loop's pass/fail)

- [ ] unit: `resolveAspect` — 1920×1080→1.7778, 1080×1920→0.8 (clamped), 1000×1000→1, 2350×1000→1.91
      (clamped), null→1.6, zero/negative→1.6.
- [ ] unit: `describeOrientation` — all four copy variants, including the photo case reading 16:10.
- [ ] render: firing `loadedmetadata` with 1080×1920 puts `aspect-ratio: 0.8` on the media element and the
      portrait copy on screen.
- [ ] render: before metadata, the box is at the 16:10 fallback and the readout asserts no orientation.
- [ ] render: swapping the file clears the previous readout.
- [ ] guardrail: the preview renders no watermark element — pins the "no watermarking in admin" rule so this
      change cannot quietly add one.
- [ ] Existing compose tests + `npm test` green.

## Open questions — RESOLVED

- Does this epic touch admin at all? → **yes, the compose preview. Posting mechanics do not.**
- Does admin write `aspect_ratio`? → **no; capture is the webhook's (ENG-557)**
- Does compose gain a field or an orientation picker? → **no; detected and displayed, never chosen**
- Share the clamp constants with mobile? → **no — separate repos; restated in full in both tickets**
- Photos too? → **measured and shown, but the readout says members see 16:10**
