# ENG-633 — compose preview: no media box on a text post

`before/` is the state on `feature/feedback-v5` (A2, PR #40): the text preview draws a large
black box captioned "Media preview" for a post that renders with no media box at all in the
member app.

`after/` is this PR: the media box and the orientation readout are gated on the post carrying
an asset, so a text post renders header -> reactions -> body, matching the member card.

The preview panel shrinks 572px -> 314px, and the full-page compose shot 1352px -> 1137px:
exactly the height of the removed box.
