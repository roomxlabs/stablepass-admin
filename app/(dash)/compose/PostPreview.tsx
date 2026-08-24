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
import type { MeasureState, MediaDimensions, MediaType } from "./types";
import {
  describeOrientation,
  displayHorseName,
  isReelPreview,
  isUploadType,
  resolveAspect,
} from "./types";
import HlsVideo from "./HlsVideo";
import styles from "./compose.module.css";

export type PostPreviewData = {
  horseName: string | null;
  byline: string | null;
  caption: string;
  mediaType: MediaType | null;
  mediaUrl: string | null;
  /** Drives the "Race day" badge. Real data, never hardcoded. */
  racesToday: boolean;
  /**
   * ENG-769 — the editorial category picked in ENG-745's label picker, or null
   * for "No label".
   *
   * The preview needs it for the reason this ticket exists: the member card
   * renders the label pill INSIDE the white header row, and a reel has no
   * white header row, so a label chosen for a portrait video reaches no
   * member. The preview cannot tell the operator that without knowing whether
   * they picked one.
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
  const { horseName, byline, caption, mediaType, mediaUrl, racesToday, dims, measure, photos, label } =
    data;

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

  // Racing names are registered ALL CAPS; members read them title-cased.
  const shownName = horseName ? displayHorseName(horseName) : "Select a horse";
  const initial = (shownName.trim()[0] ?? "S").toUpperCase();

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

  // The label reaches no member on a reel (see PostPreviewData.label). Its own
  // flag because two places need it: the pill stands down, AND the operator is
  // told why — a pill that silently vanishes is the same lie in a new place.
  const labelText = label?.trim() ? label.trim() : null;
  const labelUnrendered = isReel && labelText !== null;

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
              Everything inside it goes with it — the label pill AND the race
              badge included, which is why a reel shows neither. */}
          {isReel ? null : (
          <header className={styles.postHead}>
            <div className={styles.postAvatar} aria-hidden="true">
              {initial}
            </div>
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
              <p className={styles.postHorse}>{shownName}</p>
              <div className={styles.postByline}>
                {byline ? (
                  <>
                    by <span className={styles.postByTrainer}>{byline}</span> · just now
                  </>
                ) : (
                  "just now"
                )}
              </div>
            </div>
            {racesToday ? (
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
                <div className={styles.reelScrim} data-testid="preview-reel-head">
                  <div className={`${styles.postAvatar} ${styles.reelAvatar}`} aria-hidden="true">
                    {initial}
                  </div>
                  <div className={styles.reelMeta}>
                    <p className={styles.reelHorse}>{shownName}</p>
                    {/* No leading "by" — mobile's reel byline is
                        `trainerName · postedAgo`, where the classic card's
                        reads "by <trainer> · just now". Matching the member
                        card, not this file's other byline. */}
                    <div className={styles.reelByline}>
                      {byline ? `${byline} · just now` : "just now"}
                    </div>
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

      {/* WHY THE PILL VANISHED. Without this the reel chrome silently drops a
          label the operator deliberately chose, which is the same class of
          quiet lie as the old blind crop — just moved one control over.
          role=status because it appears and disappears under them (picking a
          label, or swapping the media for a portrait video) with no action of
          their own on this element. */}
      {labelUnrendered ? (
        <p
          className={styles.previewReelNote}
          role="status"
          data-testid="preview-reel-label-note"
        >
          Reels show no label pill, so “{labelText}” will not appear on the member card. The label
          is still saved with the post.
        </p>
      ) : null}

      <div className={styles.previewFootnote}>
        This is the member card. Web renders the same content in a wider column.
      </div>
    </div>
  );
}
