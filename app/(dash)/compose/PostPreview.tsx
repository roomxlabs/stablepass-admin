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
import { describeOrientation, displayHorseName, isUploadType, resolveAspect } from "./types";
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
  /** Measured off the picked file in the browser; null until metadata lands. */
  dims: MediaDimensions;
  /** `off` outside a fresh local pick — see MeasureState. */
  measure: MeasureState;
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
  const { horseName, byline, caption, mediaType, mediaUrl, racesToday, dims, measure } = data;

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
        <article className={styles.postCard} data-testid="post-preview">
          <header className={styles.postHead}>
            <div className={styles.postAvatar} aria-hidden="true">
              {initial}
            </div>
            <div className={styles.postMetaWrap}>
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

          {/* Flush to the card edges, at the MEASURED ratio, neutral ground
              behind unpainted media. The CSS default is 16:10 so the box is
              never 0-height while metadata loads. Absent entirely for a post
              that carries no asset — see hasMediaBox. */}
          {hasMediaBox ? (
            <div className={styles.postMedia} data-testid="preview-media" style={{ aspectRatio: `${aspect}` }}>
              {mediaUrl && mediaType === "photo" ? (
                // eslint-disable-next-line @next/next/no-img-element -- local object URL, not a remote asset
                <img
                  src={mediaUrl}
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

      <div className={styles.previewFootnote}>
        This is the member card. Web renders the same content in a wider column.
      </div>
    </div>
  );
}
