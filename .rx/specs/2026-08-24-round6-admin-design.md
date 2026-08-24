# Round 6 polish, admin slices (R4–R8) — design spec

Epic: ENG-737. Tickets: ENG-745 (R4), ENG-748 (R5), ENG-746 (R6), ENG-749 (R7), ENG-747 (R8). Gate: ENG-764.
Grilled 24 Aug 2026. Base branch: `feature/round6-v1`. Serialization inside this repo:
R4 → R5 (both own ComposeScreen.tsx); R6 → R7 (both own TrainerForm.tsx).

## R4 — Compose: label picker, caption cap removed, horse picker scrollable (ENG-745, blocked by R1)
- Label picker: 13 presets + "No label" (null), in the metadata section beside Title (ComposeScreen.tsx:950-962). ONE preset constant, drift-tested against `docs/specs/api-contract.md`.
- Routes: POST accepts optional `label` (validated; off-list 400; DB 23514 mapped to 400); PATCH FIELD_MAP gains `label` (null clears); GET select list gains `label`. Edit seed (`page.tsx:136-137`) gains label.
- Caption: DELETE the 240 cap (`CAPTION_MAX` at :32, `maxLength` at :977, `captionOver` at :553); keep a passive character count. No BE cap exists (verified).
- Horse picker: drop `slice(0, 8)` (:189-193); results scrollable (max-height + overflow); filter kept; all horses reachable.
- Tests: route matrices + 403s; picker renders all presets; caption input has NO maxLength (assert absence); 9th horse reachable.

## R5 — Compose multi-photo (ENG-748, blocked by R2 + R4)
- Photo posts only, `multiple` file input, cap 10 (client message + R2's CHECK). Bytes DIRECT to Storage (compose/api.ts:4-7 rule). Paths: first `<postId>/original`, extras `<postId>/photo-<n>`.
- Thumbnail strip with up/down + remove (no drag). BFF writes `post_media` rows atomically and maintains the `post.media_url` = row-0 mirror (R2 contract).
- `PostPreview.tsx` dots carousel for >1 photo. Legacy single-photo behaviour byte-identical.
- Edge: partial upload failure keeps the uploaded set + retry; no orphan row without its object.

## R6 — TrainerForm: honest 409 + website_url field (ENG-746)
- Slug-collision 409 gets an honest message (name → same slug; change name or edit the existing trainer). PIN the diagnosis with a route repro test; if reproduction shows a different cause, the message follows reality and the ticket notes it.
- `website_url`: "Website" field (optional, http(s)-only, empty → null); POST insert + PATCH FIELD_MAP + select echo gain the column; server-side scheme validation 400. Column exists since 19 Jul (analytics migration) but was un-settable from anywhere (verified). Keep Website OUT of the Contacts block (trainer_contact is internal-only; website_url is public by design).

## R7 — Photo crop at upload (ENG-749, blocked by R6)
- Crop-at-upload, NO schema change: square pan/zoom crop step bakes the crop via canvas before the existing direct-to-Storage upload. Shared `PhotoCropField` used by HorseForm + TrainerForm. "Use as-is" bypass. JPEG q~0.9 max edge 1200; preserve PNG for png sources. Watermark guardrail unaffected (pre-upload crop creates the source; never mutate a stored asset).
- Tests: crop maths pure functions; Apply uploads the cropped Blob (assert the arg), use-as-is uploads the original.

## R8 — Portrait preview verify (ENG-747)
- Verify a 9:16 upload's preview against the local stack; screenshot + verdict on the ticket; fix within PostPreview/types.ts only if red.
- REGARDLESS: `describeOrientation` (:224-249) still says "cropped to 4:5" for reels; after the 18-Aug reel work that is wrong. Update the copy + `preview.test.ts`.

## Guardrails
Every route behind requireAdmin() (403 tests stay); content admin-gated; media bytes never transit our server; no public buckets; trainer_contact never surfaces.
