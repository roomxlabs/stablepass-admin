// The member post card, duplicated in the admin repo so Compose can preview
// exactly what a subscriber will see (ticket: "reuse the member post
// component ... duplicated in this repo"). No watermark is baked in here — the
// stablepass overlay is applied member-side at display time (guardrail: no
// watermarking in admin).
import type { MediaType } from "./types";
import HlsVideo from "./HlsVideo";
import styles from "./compose.module.css";

export type PostPreviewData = {
  horseName: string | null;
  byline: string | null;
  caption: string;
  mediaType: MediaType | null;
  mediaUrl: string | null;
};

export default function PostPreview({ data }: { data: PostPreviewData }) {
  const { horseName, byline, caption, mediaType, mediaUrl } = data;
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

      <div className={styles.postMedia}>
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
