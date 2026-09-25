// The member post card, duplicated in the admin repo so Compose can preview
// exactly what a subscriber will see. No watermark is baked in here — the
// stablepass overlay is applied member-side at display time (guardrail: no
// watermarking in admin).
//
// ENG-558 made that claim true again. The shipped preview lied five ways: a
// hardcoded "Race day" badge, no reaction bar or bookmark, the caption above
// the reactions instead of below, a raw ALL-CAPS racing name, and a fixed 16:9
// media box that blind-cropped every reel. Design source for this layout is
// 06-stage1-design/mockups/web/admin/screens/03-compose.html (round 5 re-cut).
"use client";

import { useState } from "react";
import type { MeasureState, MediaDimensions, MediaType, Subject } from "./types";
import {
  describeOrientation,
  displayHorseName,
  isReelPreview,
  isUploadType,
  resolveAspect,
  STABLEPASS_HANDLE,
} from "./types";
import HlsVideo from "./HlsVideo";
import styles from "./compose.module.css";

export type PostPreviewData = {
  /**
   * ENG-1268 — WHO the post is posted as, which is what decides the head.
   *
   * Optional so the dozens of literals in the existing tests keep compiling;
   * absent means `horse`, the subject every post had before this ticket, and
   * the horse head below is byte-identical to the one that shipped.
   */
  subject?: Subject;
  horseName: string | null;
  /**
   * The attribution line, and its meaning follows the subject: the TRAINER's
   * name for a horse post (rendered "by <name> · just now"), and the chosen
   * `post_byline` NAME for a StablePass post (rendered on its own, under
   * "stablepass"). A trainer post takes neither — the trainer IS the head.
   */
  byline: string | null;
  /**
   * ENG-1268 — the trainer whose head this is, for the `trainer` subject.
   * `subline` is the trainer-profile header's `stable · location`.
   *
   * Passed in already-derived rather than as a `TrainerOption`, because the
   * preview must not care where a trainer came from (the picker list, or the
   * post's own embedded row in edit mode).
   */
  trainer?: { name: string; photoUrl: string | null; subline: string } | null;
  caption: string;
  mediaType: MediaType | null;
  mediaUrl: string | null;
  /** Drives the "Race day" badge. Real data, never hardcoded. */
  racesToday: boolean;
  /**
   * ENG-769 — the editorial category picked in ENG-745's label picker, or null
   * for "No label".
   *
   * ENG-1438: the member card now renders the pill in BOTH chromes — the
   * classic white header row and the reel's scrim — so the preview draws it in
   * both. (It used to be header-row-only, which meant a label chosen for a
   * portrait video reached no member and this preview had to say so.)
   *
   * Optional so the many existing test harnesses that build a PostPreviewData
   * by hand keep compiling; absent and null both mean "no label".
   */
  label?: string | null;
  /** Measured off the picked file in the browser; null until metadata lands. */
  dims: MediaDimensions;
  /** `off` outside a fresh local pick — see MeasureState. */
  measure: MeasureState;
  /**
   * ENG-748 — the ordered photo set for a multi-photo post, as preview URLs in
   * DISPLAY order. Photo posts only.
   *
   * Optional, and one photo is the same rendering case as none: ENG-740's
   * contract is explicit that a post with zero `post_media` rows renders from
   * `post.media_url` alone, so "0 rows" and "1 photo" must both draw NO dots and
   * NO pager. Only a set of two or more becomes a carousel; anything else falls
   * through to the single-image path below, unchanged.
   */
  photos?: string[];
};

export default function PostPreview({
  data,
  compact = false,
  onMeasure,
}: {
  data: PostPreviewData;
  /** Sidebar scale (the drawn mockup). Off = the member card's true scale. */
  compact?: boolean;
  /** Called once the browser knows the file's intrinsic size, or can't. */
  onMeasure?: (dims: MediaDimensions) => void;
}) {
  const {
    horseName,
    byline,
    caption,
    mediaType,
    mediaUrl,
    racesToday,
    dims,
    measure,
    photos,
    label,
    trainer,
  } = data;
  const subject: Subject = data.subject ?? "horse";

  // ENG-748 — the carousel, and ONLY for two or more photos on a photo post.
  //
  // Video is deliberately excluded rather than "not text": a video post is a
  // single Mux asset (ENG-740 decision 3) and routing it through here would put
  // a pager on a reel and re-render it through the <img> branch, undoing
  // ENG-747's 9:16 fix. Voice has no frame at all.
  const gallery = mediaType === "photo" && (photos?.length ?? 0) > 1 ? photos! : null;
  const [shown, setShown] = useState(0);
  // Clamped on READ rather than corrected in an effect: the operator can delete
  // the photo currently being shown, and an effect would paint one frame of a
  // blank box (or an out-of-range read) before it ran. Deriving keeps the index
  // valid in the same render that shortened the list.
  const index = gallery ? Math.min(shown, gallery.length - 1) : 0;
  const shownUrl = gallery ? gallery[index] : mediaUrl;

  // The native control bar is opaque and eats the bottom ~21% of a 16:9 box, so
  // showing it by default would hide the very edge this ticket exists to make
  // visible. It appears once the operator actually starts playback — before
  // that the frame is unobstructed and the preview is honest about framing.
  const [played, setPlayed] = useState(false);

  // ---------------------------------------------------------------------
  // THE HEAD, BY SUBJECT (ENG-1268) — derived once, rendered once.
  //
  // ONE PREVIEW COMPONENT, and the head is a value rather than three copies of
  // the header JSX. ENG-558's gotcha is explicit that the second copy IS the
  // bug: this card already drifted from the member card twice, both times
  // because a duplicate existed to drift. The classic header and the reel
  // scrim both read these three fields, so a subject can never render one way
  // in a portrait video and another way in a landscape one.
  //
  // Racing names are registered ALL CAPS; members read them title-cased —
  // which applies to the HORSE name only, never to a trainer's or to the
  // brand's own lowercase wordmark.
  // ---------------------------------------------------------------------
  const horseShownName = horseName ? displayHorseName(horseName) : "Select a horse";
  const shownName =
    subject === "stablepass"
      ? STABLEPASS_HANDLE
      : subject === "trainer"
        ? trainer?.name ?? "Select a trainer"
        : horseShownName;
  const initial = (shownName.trim()[0] ?? "S").toUpperCase();
  /**
   * The avatar photo, for a TRAINER head only.
   *
   * A horse head has never shown the horse's photo here (it draws the initial
   * on the green gradient, matching the member card), and the StablePass head
   * draws the S-mark instead — so this is deliberately not "the subject's
   * picture", it is the one case that has one.
   */
  const headPhoto = subject === "trainer" ? trainer?.photoUrl ?? null : null;
  /**
   * The line under the name.
   *
   * Three genuinely different sentences, not one template: a horse post is
   * attributed TO someone ("by Chris Waller · just now"), a trainer post is
   * BY the head itself so it prints the trainer-profile subline instead
   * (`stable · location`), and a StablePass post prints the chosen byline
   * alone. `subline` is empty for a trainer with neither stable nor location,
   * and an empty line renders nothing rather than a stray separator.
   */
  const headSubline =
    subject === "trainer"
      ? trainer?.subline ?? ""
      : subject === "stablepass"
        ? byline?.trim() ?? ""
        : "";
  /**
   * RACE DAY IS A HORSE FACT. A trainer post and a StablePass post have no
   * horse at all (`post.horse_id` is null for both since B1), so there is no
   * race to badge — and a badge with nothing behind it is precisely the
   * hardcoded lie ENG-558 removed. Gated on the SUBJECT, not on `racesToday`
   * being falsy, so a stale `true` left over from a horse the operator
   * switched away from cannot leak a badge onto the new head.
   */
  const showRaceBadge = subject === "horse" && racesToday;

  // The box the member app will actually use, so a 9:16 reel visibly clamps —
  // and a photo sits at 16:10, agreeing with the readout above it.
  const aspect = resolveAspect(dims, mediaType);

  // Only the three types that carry an uploaded asset get a media box. A text
  // post's title and body ARE the post: the member card runs header → reactions
  // → body with no box at all, so drawing an empty black "Media preview"
  // placeholder here promises the operator a box no subscriber will ever see.
  // That is the same class of lie A1 (ENG-558) deleted the fake web pane to
  // remove, on the one type whose card anatomy differs most (ENG-633).
  //
  // Membership in UPLOAD_TYPES via `isUploadType`, never `!== "text"`: post.type
  // still permits `news`, and page.tsx casts a loaded row's type straight to
  // MediaType, so a negative test would wave a fifth type through into a box it
  // has no asset for. One list, so the two can't diverge.
  //
  // `null` is deliberately on the no-box side. ComposeScreen reports a text post
  // as `mediaType: null` rather than "text" (see its previewData comment), so a
  // guard on the literal alone would leave the actual screen unfixed. Both the
  // null and the "text" spellings are covered by tests.
  //
  // NOT "hide the box whenever there is no file": a photo/video/voice post shows
  // its empty box before a file is picked, which is the operator's drop target.
  const hasMediaBox = mediaType !== null && isUploadType(mediaType);

  // THE REEL DECISION (ENG-769). The SAME predicate that chose the box above,
  // so the shape and the furniture can never disagree — that split is the
  // whole bug: before this, `resolveAspect` drew a 9:16 box and the card
  // around it stayed a classic card, which is not what any member sees.
  //
  // Also gated on `hasMediaBox`: a reel is a treatment OF a media box, and a
  // post with no asset has none. `isReelPreview` already returns false for
  // text/voice/photo, so this is defence in depth against a future widening,
  // not a second opinion about what a reel is.
  const isReel = hasMediaBox && isReelPreview(dims, mediaType);

  // ENG-1438 — the label now reaches the member on a reel too. Mobile builds
  // the pill once and slots it into BOTH heads, so this preview draws it in
  // both chromes and there is no longer a "why did my pill vanish" note to
  // print. One value, two drawing sites, which is what stops the reel's pill
  // and the classic one being able to disagree about the label's text.
  const labelText = label?.trim() ? label.trim() : null;

  return (
    <div className={`${styles.previewBlock} ${compact ? styles.previewCompact : ""}`}>
      {/* Detected, never chosen. Absent entirely until a file is picked, and
          in edit mode, where the source is an HLS rendition we can't trust.
          role=status because the line CHANGES under the operator ("Measuring…"
          then the result) without them acting, so a screen reader has to be
          told. Polite, not assertive: it is advisory and never blocks posting. */}
      {/* Also gated on hasMediaBox: describeOrientation has nothing to describe
          on a post with no asset, and a stale "1920×1080 · Landscape 16:9" left
          over from a file picked before the operator switched to Text would
          describe media the post no longer has. ComposeScreen does reset
          `measure` on a type change, but the preview must not depend on that to
          stay honest. */}
      {hasMediaBox && measure !== "off" ? (
        <div className={styles.previewReadout} role="status" data-testid="preview-readout">
          {measure === "measuring" ? "Measuring…" : describeOrientation(dims, mediaType)}
        </div>
      ) : null}

      <div className={styles.previewTray}>
        <article
          className={`${styles.postCard} ${isReel ? styles.postCardReel : ""}`}
          data-testid="post-preview"
          /* The single assertable fact about WHICH chrome is drawn. Vitest
             stubs CSS modules (see compose-css.test.ts), so a render test can
             otherwise never prove the treatment — the whole reel branch could
             be reverted with the suite green, which is the failure mode this
             ticket is a re-fix of. */
          data-chrome={isReel ? "reel" : "classic"}
        >
          {/* THE WHITE HEADER ROW — CLASSIC CARDS ONLY.
              On a reel the member card overlays the identity on the frame
              instead and this row stands down entirely (mobile
              `post-card.tsx`: `{isReel ? null : (<View style={styles.head}>`).

              WHAT GOES WITH IT, and what does not (ENG-1438). The RACE BADGE
              goes: mobile slots it into the classic head only
              (`above={raceBadgeNode}`), so a reel shows none and neither does
              this preview. The LABEL PILL does NOT go any more — mobile slots
              the same pill into both heads, so the reel scrim below draws its
              own. Both facts are pinned in reel-chrome-parity.test.ts. */}
          {isReel ? null : (
          <header className={styles.postHead} data-subject={subject}>
            <PreviewAvatar
              subject={subject}
              initial={initial}
              photoUrl={headPhoto}
              className={styles.postAvatar}
            />
            <div className={styles.postMetaWrap}>
              {/* ABOVE the horse name, never in its slot (mobile ENG-750: the
                  earlier hardcoded badge displaced the name and took its tap
                  target with it). Null label = no pill and no gap. */}
              {labelText ? (
                <span
                  className={`${styles.pill} ${styles.pillDot} ${styles.labelPill}`}
                  data-testid="preview-label"
                >
                  {labelText}
                </span>
              ) : null}
              <p className={styles.postHorse} data-testid="preview-head-name">
                {shownName}
              </p>
              <div className={styles.postByline} data-testid="preview-head-sub">
                {subject === "horse" ? (
                  byline ? (
                    <>
                      by <span className={styles.postByTrainer}>{byline}</span> · just now
                    </>
                  ) : (
                    "just now"
                  )
                ) : headSubline ? (
                  // Trainer: `stable · location`. StablePass: the byline. Both
                  // in the same green the horse head gives the trainer's name,
                  // because in both cases this line IS the attribution — the
                  // muted "· just now" tail belongs to the horse card's
                  // "posted by someone else" sentence and would read as noise
                  // under a head that is already the author.
                  <span className={styles.postByTrainer} data-testid="preview-head-subline">
                    {headSubline}
                  </span>
                ) : (
                  // A trainer with neither stable nor location, or a
                  // StablePass post before a byline is chosen. Never a bare
                  // separator, and never "just now" — see above.
                  <span className={styles.postBylineEmpty}>
                    {subject === "stablepass" ? "Choose a byline" : "just now"}
                  </span>
                )}
              </div>
            </div>
            {showRaceBadge ? (
              <span
                className={`${styles.pill} ${styles.pillGreen} ${styles.pillDot} ${styles.raceBadge}`}
                data-testid="preview-race-badge"
              >
                Race day
              </span>
            ) : null}
          </header>
          )}

          {/* Flush to the card edges, at the MEASURED ratio, neutral ground
              behind unpainted media. The CSS default is 16:10 so the box is
              never 0-height while metadata loads. Absent entirely for a post
              that carries no asset — see hasMediaBox. */}
          {hasMediaBox ? (
            <div className={styles.postMedia} data-testid="preview-media" style={{ aspectRatio: `${aspect}` }}>
              {shownUrl && mediaType === "photo" ? (
                // eslint-disable-next-line @next/next/no-img-element -- local object URL, not a remote asset
                <img
                  // Keyed by URL so flipping the carousel actually swaps the
                  // decoded image instead of React reusing the element and
                  // firing no onLoad — which would leave the readout describing
                  // the photo the operator just paged away from.
                  key={shownUrl}
                  src={shownUrl}
                  alt=""
                  data-testid="preview-img"
                  onLoad={(e) =>
                    onMeasure?.({
                      width: e.currentTarget.naturalWidth,
                      height: e.currentTarget.naturalHeight,
                    })
                  }
                  onError={() => onMeasure?.(null)}
                />
              ) : mediaUrl && mediaType === "video" ? (
                // Playable in the modal, where there is room to vet the actual
                // video — click the frame to start it. NOT playable in the
                // compact rail: the native control bar plus its black band eats
                // ~40% of that small box, and a member sees none of it, so the
                // rail preview would lie about framing.
                //
                // The same argument applies to the modal until playback starts,
                // which is why `controls` waits for `played` rather than being on
                // from the outset: the considered look is the one that most needs
                // an unobstructed frame.
                <HlsVideo
                  src={mediaUrl}
                  controls={!compact && played}
                  muted={compact}
                  playsInline
                  preload="metadata"
                  data-testid="preview-video"
                  onClick={
                    compact
                      ? undefined
                      : (e) => {
                          const v = e.currentTarget;
                          if (v.paused) void v.play();
                          else v.pause();
                        }
                  }
                  onPlay={() => setPlayed(true)}
                  onLoadedMetadata={(e) =>
                    onMeasure?.({
                      width: e.currentTarget.videoWidth,
                      height: e.currentTarget.videoHeight,
                    })
                  }
                  onError={() => onMeasure?.(null)}
                />
              ) : (
                <div className={styles.postMediaEmpty}>Media preview</div>
              )}

              {/* THE REEL HEADER (ENG-769) — the identity overlaid on a top
                  ink scrim, which is where it goes when the white row above
                  stands down. Instagram's reel layout in the stablepass
                  palette, mirroring mobile's `reelTopScrim` block.

                  A SIBLING of the media element, not a wrapper: the video is
                  clickable to play in the modal, and nesting it inside an
                  overlay would swallow that. The scrim itself is
                  pointer-events:none for the same reason.

                  NO follow pill here, and none on the classic card either —
                  this preview has never modelled Follow (mobile draws it from
                  `onFollowTrainer`, which has no analogue in Compose). So
                  "a reel shows no follow pill" is true here by construction
                  rather than by suppression; the parity test records that
                  explicitly so it cannot be mistaken for an oversight. */}
              {isReel ? (
                <div className={styles.reelScrim} data-testid="preview-reel-head" data-subject={subject}>
                  <PreviewAvatar
                    subject={subject}
                    initial={initial}
                    photoUrl={headPhoto}
                    className={`${styles.postAvatar} ${styles.reelAvatar}`}
                  />
                  <div className={styles.reelMeta}>
                    <p className={styles.reelHorse}>{shownName}</p>
                    {/* No leading "by" — mobile's reel byline is
                        `trainerName · postedAgo`, where the classic card's
                        reads "by <trainer> · just now". Matching the member
                        card, not this file's other byline.

                        ENG-1268: the same three-subject split as the classic
                        head above, reading the SAME derived values, so a
                        portrait video and a landscape one can never disagree
                        about who posted it. Only the horse card appends
                        "· just now" — the other two heads are the author. */}
                    <div className={styles.reelByline}>
                      {subject === "horse"
                        ? byline
                          ? `${byline} · just now`
                          : "just now"
                        : headSubline || (subject === "stablepass" ? "Choose a byline" : "")}
                    </div>
                    {/* THE REEL'S LABEL PILL (ENG-1438) — BELOW the byline,
                        closing the stack, which is where mobile's
                        `labelPillStacked` puts it on both heads. Not above the
                        name: that is the classic card's older placement in this
                        file, and copying it here would put admin's two chromes
                        at odds with each other as well as with mobile.

                        Same `labelText` the classic head renders, so the two
                        can never show different copy for one chosen label. */}
                    {labelText ? (
                      <span className={styles.reelLabelPill} data-testid="preview-reel-label">
                        <span className={styles.reelLabelPillDot} aria-hidden="true" />
                        <span className={styles.reelLabelPillText}>{labelText}</span>
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {/* ENG-748 — the member carousel's dots, the pager R16/R21 build
                  against. Absent entirely for one photo (and for none), per
                  ENG-740's rule that a post with no post_media rows renders
                  exactly like a single-photo one.

                  Real buttons, not decoration: the operator is checking the
                  order they just arranged, so every photo has to be reachable —
                  and reachable by keyboard, which is why this is not a row of
                  <span>s with an onClick. The label names the position because
                  "dot" tells a screen-reader user nothing about where they are. */}
              {gallery ? (
                <div className={styles.carouselDots} data-testid="preview-dots">
                  {gallery.map((url, i) => (
                    <button
                      key={url}
                      type="button"
                      className={`${styles.carouselDot} ${i === index ? styles.carouselDotOn : ""}`}
                      aria-label={`Show photo ${i + 1} of ${gallery.length}`}
                      aria-current={i === index}
                      data-testid={`preview-dot-${i}`}
                      onClick={() => setShown(i)}
                    />
                  ))}
                </div>
              ) : null}

              {/* The count, so the operator can see "3 photos" without counting
                  dots. Same gate as the dots — never shown for a single photo. */}
              {gallery ? (
                <span className={styles.carouselCount} data-testid="preview-count">
                  {index + 1}/{gallery.length}
                </span>
              ) : null}
            </div>
          ) : null}

          {/* The real card's reaction bar + bookmark. Non-interactive here: the
              operator is looking at anatomy, not reacting to their own post. */}
          <div className={styles.postActions} data-testid="preview-reactions" aria-hidden="true">
            <span className={styles.postActionHeart}>
              <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
                <path
                  d="M12 21s-7.5-4.9-9.6-9A5.4 5.4 0 0 1 12 6.2 5.4 5.4 0 0 1 21.6 12c-2.1 4.1-9.6 9-9.6 9z"
                  fill="currentColor"
                />
              </svg>
            </span>
            <span className={styles.postActionCount}>0</span>
            <span className={styles.postActionSpacer} />
            <span className={styles.postActionBookmark} data-testid="preview-bookmark">
              <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
                <path
                  d="M6.5 3.8h11a1 1 0 0 1 1 1v15.4l-6.5-4-6.5 4V4.8a1 1 0 0 1 1-1z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </div>

          {/* BELOW the reaction bar, as on the member card (decided 5 Aug). */}
          <div className={styles.postBody} data-testid="preview-caption">
            {caption.trim() ? caption : "Your caption will appear here."}
          </div>
        </article>
      </div>

      {/* ENG-1438 — "WHY THE PILL VANISHED" used to live here. It no longer
          does, because the pill no longer vanishes: mobile draws it on the reel
          too and so does the scrim above. The note is DELETED rather than
          softened; an explanation that outlives the thing it explained is the
          same quiet lie it was written to prevent, just pointing the other way. */}

      <div className={styles.previewFootnote}>
        This is the member card. Web renders the same content in a wider column.
      </div>
    </div>
  );
}

/**
 * The head avatar, for all three subjects and for both chromes.
 *
 * ONE component rather than an inline ternary in each of the two places a head
 * is drawn — which is the ENG-558 rule applied one level down: the classic
 * header and the reel scrim must never be able to disagree about what a
 * StablePass post's avatar is.
 *
 * - horse → the initial on the green gradient (unchanged; the member card has
 *   never shown the horse's own photo here).
 * - trainer → the trainer's photo, falling back to the initial when they have
 *   none or the signed URL failed — the existing avatar fallback, not a new one.
 * - stablepass → the S-mark. The asset is ALREADY the mark on `--brand-green`
 *   (#285D50, the exact token), so it fills the circle rather than sitting on a
 *   tinted background that would double the green.
 *
 * `aria-hidden` throughout: the name is right beside it in text, so announcing
 * the avatar would read the subject twice.
 */
function PreviewAvatar({
  subject,
  initial,
  photoUrl,
  className,
}: {
  subject: Subject;
  initial: string;
  photoUrl: string | null;
  className: string;
}) {
  if (subject === "stablepass") {
    return (
      <div
        className={`${className} ${styles.markAvatar}`}
        data-testid="preview-avatar-mark"
        aria-hidden="true"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset in /public, fixed 44px box */}
        <img src="/brand/mark.png" alt="" />
      </div>
    );
  }
  if (subject === "trainer" && photoUrl) {
    return (
      <div
        className={`${className} ${styles.photoAvatar}`}
        data-testid="preview-avatar-photo"
        aria-hidden="true"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- signed trainer photo, fixed 44px box */}
        <img src={photoUrl} alt="" />
      </div>
    );
  }
  return (
    <div className={className} data-testid="preview-avatar-initial" aria-hidden="true">
      {initial}
    </div>
  );
}
