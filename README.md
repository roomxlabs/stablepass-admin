# ENG-749 — profile photo crop: screenshot evidence

Evidence for [PR #48](https://github.com/roomxlabs/stablepass-admin/pull/48). These live on a branch
because `raw.githubusercontent` embeds 404 on this private repo, so images referenced from a PR body
render broken. Open them from the file list here, or from the PR's **Files changed** tab, where the
same PNGs are committed under `e2e/__screenshots__/`.

All imagery is **synthetic**, drawn in-page with a canvas by `e2e/photo-crop.spec.ts`. No client
photo appears in any of it. The test subject is deliberately placed in the right-hand third of a
1600×800 frame, because that is what reproduces Mel's report: a centre crop cuts it out.

## Start here

| | |
|---|---|
| `compare/crop-step-before-after.png` | The crop dialog: the default centre crop, then dragged onto the subject. The bright circle is exactly what the avatar surfaces render; the dimmed corners are saved but not shown by a circular avatar. |
| `compare/stored-photo-before-after.png` | The **stored** photo. Left is Use as-is (the untouched 1600×800 original — what every trainer photo was before this ticket). Right is Apply crop (800×800, subject centred). |

## Everything else

**before/**
- `29-trainer-crop-step-off-centre.png` — the dialog as it opens. The subject is the gold sliver at the circle's right edge; this is the bug.
- `30-trainer-photo-as-is-before.png` — TrainerForm after Use as-is. Full page, so ENG-766's marketing toggle and ENG-746's Website field are both visible and unchanged.

**after/**
- `31-trainer-crop-step-repositioned.png` — after dragging; the subject fills the circle.
- `32-trainer-photo-cropped-after.png` — TrainerForm holding the square crop.
- `33-horse-crop-step.png` — the same component on HorseForm, with copy that reads "the horse's profile".
- `34-horse-photo-cropped.png` — HorseForm holding the square crop, and the corrected card copy ("square crop", "ideally 1200×1200" — it used to say 16:9 / 1600×900, which this change made false).

## What the screenshots do not prove, and what does

A picture cannot show that the *bytes* changed — a renamed but uncropped upload would look identical
here. The spec therefore also decodes the stored object back out of Storage and asserts it:
1600×800 after Use as-is, 800×800 (square) after Apply crop, plus the served `Content-Type` and the
key's extension. Those assertions are the actual proof; these images are what makes it legible.

Two of the shots were caught being wrong by looking at them side by side, which is the argument for
attaching them: the dialog rendered centred on HorseForm and left-aligned on TrainerForm (an
inherited `text-align`), and HorseForm's card copy still recommended 16:9. Both fixed, and every
image here was re-shot from the final tree afterwards.
