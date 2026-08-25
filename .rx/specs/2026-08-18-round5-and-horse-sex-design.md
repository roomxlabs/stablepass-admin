# Round 5 + ENG-304 — admin slices

Grilled 17 to 18 Aug 2026. Three slices touch this repo, across two epics.

| Slice | Linear | Epic | Base branch |
|---|---|---|---|
| A1 | ENG-558 (re-scoped) | ENG-603 round 5 | `feature/feedback-v5` |
| A2 | ENG-611 | ENG-603 round 5 | `feature/feedback-v5` |
| H2 | ENG-616 | ENG-304 horse sex | `feature/horse-sex-v1` |

A2 is blocked by A1 (both edit `compose.module.css` and `ComposeScreen.tsx`). H2 is on a
different branch and blocked by the be migration being **deployed**, not merely merged.

## The design source, and the manifest that was wrong

`.rx/mockups.md` pointed at `../dev-handover/StablePass-mockups/mockups/web/admin/`, which has
**never existed**, and an earlier note "correcting" it pointed somewhere that does not exist
either. The real root is `06-stage1-design/mockups/web/admin/screens/`. Fixed 18 Aug. Resolve
worktree-safely and paste the output:

```sh
ls "$(git rev-parse --git-common-dir)/../../../06-stage1-design/mockups/web/admin/screens/"
```

Admin screens load `../../style.css` (i.e. `mockups/web/style.css`) plus `../../../icons.js`.

Re-cut for these slices: `03-compose.html` (post-type picker, honest single preview pane) and
`07-add-horse.html` (Male/Female plus a Gelded checkbox). Pre-edit copies in `_archive/`.

---

## A1 (ENG-558) — the compose preview stops lying

**PR admin#36 is open and must be RE-WORKED, not merged.** It was written on 12 Aug against the
original scope; the grill re-scoped it.

Five fidelity bugs found in the shipped screen, all verified:

1. `PreviewModal.tsx:45` and `:62` render **the same `<PostPreview>`** in both the "Mobile" and
   "Web" panes. Only the frame differs. **The web pane is decoration.**
2. `PostPreview.tsx:40` hardcodes a `Race day` badge on **every** post.
3. No reaction bar and no bookmark, whereas the real member card has both.
4. The caption sits under the media; the real card puts it **below the reaction bar** (5 Aug).
5. Raw `horseName`, whereas the real card uses `displayHorseName()`.

**Decision (b): drop the fake web pane.** One honest member-accurate preview, the
detected-orientation readout, and a sentence saying web renders the same content in a wider
column. Option (a), a third faithful copy of the member card, was rejected as a standing
maintenance tax.

The clamp, restated in full rather than referenced (separate codebases drift):

```ts
ASPECT_MIN = 0.8;      // 4:5 portrait
ASPECT_MAX = 1.91;     // 1.91:1 landscape
ASPECT_DEFAULT = 1.6;  // 16:10, for an unknown ratio
```

Photos carry no Mux aspect, so the readout for a photo must say **members see it at 16:10**,
not the measured ratio. Do not let the preview promise something the app will not do.

---

## A2 (ENG-611) — a post-type selector, plus text and voice

**Neither text nor voice needs a migration.** `post.type` has allowed
`('video','photo','text','voice','news')` since the baseline schema, and `title`, `body` and
`media_url` all exist. What actually blocked them was in this repo:

- `CREATABLE_TYPES = ["video","photo"]` at `app/api/admin/posts/route.ts:7`
- `MediaType = "video" | "photo"` in `compose/types.ts`
- **No post-type control at all.** The type was sniffed from the picked file's MIME, so a text
  post was unauthorable and a voice post had no entry point.

Also already true and not to be redone: **compose already has a working `title` field** that
persists through POST and PATCH, and **publish does not require media**.

```ts
type MediaType = "video" | "photo" | "voice" | "text";
const UPLOAD_TYPES = ["video", "photo", "voice"] as const;   // `text` has no asset
const CREATABLE_TYPES = ["video", "photo", "voice", "text"];
```

| type | Upload target | `media_url` at create |
|---|---|---|
| video | Mux direct upload, `passthrough = post.id` | no, the webhook fills it |
| photo | Storage signed upload, `post-media/<id>/original` | yes |
| voice | Storage signed upload, `post-media/<id>/original` | yes |
| text | **none**, 202 with just the draft | no |

Text requires a non-empty body, validated **client-side and server-side**. A horse is still
required for every type: `post.horse_id` is NOT NULL. Sniffing is retained as **validation**, so
a MIME mismatch is an error, never a silent reclassification. `news` is deliberately not offered.

---

## H2 (ENG-616) — sex becomes two fields, and the TS formula goes

`HorseForm.tsx:16` offers `["gelding","colt","filly","mare","stallion"]`, so **the operator picks
the race-day description rather than the sex**, and nothing ever changes it as the horse ages.
That is the whole bug: a filly stays a filly at eight.

Two controls now: a `Male | Female` select plus a **Gelded** checkbox, disabled **and cleared**
when Female is selected. `stallion` disappears; the backfill maps it to `male` + not gelded.

**Delete `computeAge` and `horseMeta`** from `app/(dash)/horses/format.ts`. Admin's age formula
is *correct* about the 1 August rollover, unlike web's, but it is one of three copies and the
epic moves the rule into Postgres. Read `horse_age` and `horse_description` instead:

```ts
sb.from("horse").select("id,display_name,racing_name,foaling_year,sex,is_gelded,horse_age,horse_description,training_status,trainer:trainer_id(name)")
```

**`retired` keeps its special case**: `by <Trainer> · retired`, age dropped. It comes from
`training_status`, not sex, so the DB derivation does not cover it and it must not be lost.

**Deploy order is load-bearing.** A named PostgREST column that does not exist raises `42703`
and fails the **whole** horses query, not just the field.

---

## Guardrails that apply to all three

- **Every admin route requires `requireAdmin()` first**, and each route test must include a
  **403 for a non-admin session**, not only the happy path.
- **Admin access requires AAL2**, enforced in Postgres. An AAL1 admin reads **0 rows with no
  error**, so never treat an empty result as "no data".
- **Media split**: video to Mux, images and voice to Supabase Storage, uploaded **direct** from
  the browser. Bytes never transit our server. **No public post-media bucket.**
- **Watermark is display-time only.** No upload step re-encodes or bakes it in.
- **No owner PII.** Admin never creates, edits or stores a horse owner, and H2 is editing
  exactly the form where one would be tempting.
- Content is admin-gated: soft-hide, never hard-delete a published post.

## Repo traps (verified)

- Route unit tests must **mock `@/lib/supabase/server`, not the gate**.
- `lib/testing/supabase-fake.ts` defaults `aal` to `"aal2"`, so an AAL1 case needs setting up.
- **Guard the payload of a Supabase call, not just its `error`**: a query-builder mock that
  swallows its arguments cannot see a wrong insert, and cannot see an IDOR.
- **Table reads that ignore `error` turn an RLS regression into "no data".**
- e2e must run against `next start`, not `next dev`, or client screens are inert.
- `e2e/mock-supabase.mjs` has a generic `/rest/v1/<table>` dispatcher that **shadows** resource
  handlers.
- A resource LIST screen has no BFF endpoint; it reads server-side via `supabaseServer()`.
