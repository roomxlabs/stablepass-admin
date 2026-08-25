"use client";

/**
 * ENG-824 — scrub a video and capture `currentTime` as `poster_time_s`.
 *
 * Compose (ENG-824): local object-URL `<video>` of the selected file.
 * Posts library (ENG-825): same scrubber over a signed Mux HLS source via
 * `HlsVideo` (src ends in `.m3u8`).
 *
 * No mockup exists for this control (`needs-design-check`): reuse the compose
 * upload-zone vocabulary (preview, uploadBtn, help) so it reads as part of
 * Step 3 / library row actions rather than a foreign widget.
 *
 * Graceful degrade: a codec the browser cannot decode (HEVC/ProRes…) fires
 * `error` on the `<video>` — we show an unavailable state and leave
 * `poster_time_s` null. Publish / re-bake is never forced.
 *
 * Remount on a new `src` (caller passes `key={src}`) rather than resetting
 * state in an effect — keeps react-hooks/set-state-in-effect happy.
 *
 * When `selectedTimeS` is set at mount (library: existing `poster_time_s`),
 * metadata load seeks to that frame so the scrubber preselects it.
 */
import { useRef, useState } from "react";
import HlsVideo from "./HlsVideo";
import styles from "./compose.module.css";

export type PosterScrubberProps = {
  /** Local object URL or signed HLS `.m3u8` URL. */
  src: string;
  /** Seconds already chosen / current poster frame, or null when none yet. */
  selectedTimeS: number | null;
  onPick: (timeS: number) => void;
  /**
   * Optional local file (compose). Kept for call-site clarity; scrubber keys
   * off `src` only. HLS library callers omit this.
   */
  file?: File;
  /** Disable scrub + pick (e.g. while a re-bake request is in flight). */
  disabled?: boolean;
};

function isHlsSrc(src: string): boolean {
  return src.split("?")[0].endsWith(".m3u8");
}

export default function PosterScrubber({
  src,
  selectedTimeS,
  onPick,
  disabled = false,
}: PosterScrubberProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState(0);
  const [scrub, setScrub] = useState(0);
  const [unavailable, setUnavailable] = useState(false);

  function onLoadedMetadata() {
    const v = videoRef.current;
    if (!v) return;
    const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    setDuration(d);
    const initial =
      selectedTimeS !== null && Number.isFinite(selectedTimeS)
        ? Math.min(Math.max(0, selectedTimeS), d || selectedTimeS)
        : Math.min(v.currentTime || 0, d || 0);
    try {
      v.currentTime = initial;
    } catch {
      /* jsdom / mid-load seek can throw — scrub state still reflects intent */
    }
    setScrub(initial);
    setUnavailable(false);
  }

  function onError() {
    setUnavailable(true);
    setDuration(0);
  }

  function onScrub(next: number) {
    setScrub(next);
    const v = videoRef.current;
    if (v) v.currentTime = next;
  }

  function useThisFrame() {
    const v = videoRef.current;
    if (!v || unavailable || disabled) return;
    const t = Number.isFinite(v.currentTime) ? v.currentTime : scrub;
    onPick(t);
  }

  const videoProps = {
    ref: videoRef,
    playsInline: true as const,
    muted: true as const,
    preload: "metadata" as const,
    "data-testid": "poster-scrubber-video",
    onLoadedMetadata,
    onError,
    onSeeked: () => {
      const v = videoRef.current;
      if (v && Number.isFinite(v.currentTime)) setScrub(v.currentTime);
    },
  };

  return (
    <div className={styles.posterScrubber} data-testid="poster-scrubber">
      <div className={styles.label}>Preview poster frame</div>
      <div className={`${styles.preview} ${styles.posterScrubPreview}`}>
        {isHlsSrc(src) ? <HlsVideo src={src} {...videoProps} /> : <video src={src} {...videoProps} />}
      </div>

      {unavailable ? (
        <div className={styles.help} data-testid="poster-scrubber-unavailable">
          This file can’t be previewed in the browser (codec unsupported). The
          default poster frame will be used — you can re-pick later from the
          posts library. Publishing is not blocked.
        </div>
      ) : (
        <>
          <input
            type="range"
            className={styles.posterScrubRange}
            min={0}
            max={duration || 0}
            step={0.01}
            value={scrub}
            disabled={disabled || !(duration > 0)}
            aria-label="Scrub poster frame"
            data-testid="poster-scrubber-range"
            onChange={(e) => onScrub(Number(e.target.value))}
          />
          <div className={styles.uploadTools}>
            <span className={styles.uploadMeta} data-testid="poster-scrub-meta">
              {duration > 0
                ? `${scrub.toFixed(2)}s / ${duration.toFixed(2)}s`
                : "Loading preview…"}
              {selectedTimeS !== null ? (
                <span data-testid="poster-time-picked">
                  {" "}
                  · using {selectedTimeS.toFixed(2)}s
                </span>
              ) : null}
            </span>
            <span className={styles.uploadActions}>
              <button
                type="button"
                className={styles.uploadBtn}
                data-testid="poster-use-frame"
                disabled={disabled || !(duration > 0)}
                onClick={useThisFrame}
              >
                Use this frame
              </button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
