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
import type { MeasureState, MediaDimensions, MediaType } from "./types";
import { describeOrientation, displayHorseName, resolveAspect } from "./types";
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

  // Racing names are registered ALL CAPS; members read them title-cased.
  const shownName = horseName ? displayHorseName(horseName) : "Select a horse";
  const initial = (shownName.trim()[0] ?? "S").toUpperCase();

  // The box the member app will actually use, so a 9:16 reel visibly clamps —
  // and a photo sits at 16:10, agreeing with the readout above it.
  const aspect = resolveAspect(dims, mediaType);

  return (
    <div className={`${styles.previewBlock} ${compact ? styles.previewCompact : ""}`}>
      {/* Detected, never chosen. Absent entirely until a file is picked, and
          in edit mode, where the source is an HLS rendition we can't trust. */}
      {measure !== "off" ? (
        <div className={styles.previewReadout} data-testid="preview-readout">
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
              <span className={styles.raceBadge} data-testid="preview-race-badge">
                Race day
              </span>
            ) : null}
          </header>

          {/* Flush to the card edges, at the MEASURED ratio, neutral ground
              behind unpainted media. The CSS default is 16:10 so the box is
              never 0-height while metadata loads. */}
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
              // video. NOT in the compact rail: the native control bar plus its
              // black band eats ~40% of that small box, and a member sees none
              // of it — which would make the rail preview lie about framing.
              <HlsVideo
                src={mediaUrl}
                controls={!compact}
                muted={compact}
                playsInline
                preload="metadata"
                data-testid="preview-video"
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
