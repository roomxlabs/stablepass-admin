// The member post card, duplicated in the admin repo so Compose can preview
// exactly what a subscriber will see (ticket: "reuse the member post
// component ... duplicated in this repo"). No watermark is baked in here — the
// stablepass overlay is applied member-side at display time (guardrail: no
// watermarking in admin).
import type { MediaDimensions, MediaType } from "./types";
import { describeOrientation, hasUsableDimensions, resolveMemberAspect } from "./types";
import HlsVideo from "./HlsVideo";
import styles from "./compose.module.css";

export type PostPreviewData = {
  horseName: string | null;
  byline: string | null;
  caption: string;
  mediaType: MediaType | null;
  mediaUrl: string | null;
  /** Measured by ComposeScreen off the picked file; null until metadata lands. */
  dimensions: MediaDimensions;
};

/**
 * The detected-orientation readout (ENG-558). Admin chrome with no member
 * equivalent, so it reuses the compose form's own hint style (`.help`) rather
 * than inventing a treatment. Renders nothing until an asset is actually on
 * screen to describe.
 */
export function MediaReadout({
  mediaType,
  mediaUrl,
  dimensions,
  measured,
}: {
  mediaType: MediaType | null;
  mediaUrl: string | null;
  dimensions: MediaDimensions;
  /** false while metadata is still in flight — never guess an orientation. */
  measured: boolean;
}) {
  if (!mediaType || !mediaUrl) return null;

  const text = measured ? describeOrientation(dimensions, mediaType) : "Measuring…";
  // Muted while pending, and when the browser could not decode the file at all
  // — in both cases the line states no orientation.
  const muted = !measured || !hasUsableDimensions(dimensions);

  return (
    // role=status: the line changes from "Measuring…" to the result with no
    // user action, so a screen reader is only told if it is announced.
    <p
      role="status"
      className={`${styles.help} ${styles.mediaReadout}${muted ? ` ${styles.mediaReadoutMuted}` : ""}`}
      data-testid="media-readout"
    >
      {text}
    </p>
  );
}

export default function PostPreview({ data }: { data: PostPreviewData }) {
  const { horseName, byline, caption, mediaType, mediaUrl, dimensions } = data;
  const initial = (horseName?.trim()[0] ?? "S").toUpperCase();

  return (
    <article className={styles.postCard} data-testid="post-preview">
      <header className={styles.postHead}>
        <div className={styles.postAvatar} aria-hidden="true">
          {initial}
        </div>
        <div className={styles.postMetaWrap}>
          <p className={styles.postHorse}>{horseName ?? "Select a horse"}</p>
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
        <span className={styles.raceBadge}>Race day</span>
      </header>

      {/* The box a member actually gets — for video the clamped real ratio, for
          photos always 16:10. Inline so it overrides the module's 16/10
          fallback, which is what keeps the box from collapsing while metadata
          is still loading. */}
      <div
        className={styles.postMedia}
        style={{ aspectRatio: String(resolveMemberAspect(dimensions, mediaType)) }}
        data-testid="post-preview-media"
      >
        {mediaUrl && mediaType === "photo" ? (
          // eslint-disable-next-line @next/next/no-img-element -- local object URL, not a remote asset
          <img src={mediaUrl} alt="" />
        ) : mediaUrl && mediaType === "video" ? (
          // Playable: native controls replace the static play glyph so the
          // operator can vet the actual video (signed HLS or local file).
          <HlsVideo src={mediaUrl} controls playsInline preload="metadata" />
        ) : (
          <div className={styles.postMediaEmpty}>Media preview</div>
        )}
      </div>

      <div className={styles.postBody}>
        {caption.trim() ? caption : "Your caption will appear here."}
      </div>
    </article>
  );
}
