"use client";

/**
 * ENG-824 — scrub a locally-selected video file and capture `currentTime` as
 * `poster_time_s` for the compose POST/PATCH.
 *
 * No mockup exists for this control (`needs-design-check`): reuse the compose
 * upload-zone vocabulary (preview, uploadBtn, help) so it reads as part of
 * Step 3 rather than a foreign widget.
 *
 * Graceful degrade: a codec the browser cannot decode (HEVC/ProRes…) fires
 * `error` on the `<video>` — we show an unavailable state and leave
 * `poster_time_s` null. Publish is never blocked.
 *
 * Remount on a new `src` (caller passes `key={src}`) rather than resetting
 * state in an effect — keeps react-hooks/set-state-in-effect happy.
 */
import { useRef, useState } from "react";
import styles from "./compose.module.css";

export type PosterScrubberProps = {
  file: File;
  /** Local object URL for `file`. */
  src: string;
  /** Seconds already chosen, or null when none yet. */
  selectedTimeS: number | null;
  onPick: (timeS: number) => void;
};

export default function PosterScrubber({
  src,
  selectedTimeS,
  onPick,
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
    setScrub(Math.min(v.currentTime || 0, d || 0));
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
    if (!v || unavailable) return;
    const t = Number.isFinite(v.currentTime) ? v.currentTime : scrub;
    onPick(t);
  }

  return (
    <div className={styles.posterScrubber} data-testid="poster-scrubber">
      <div className={styles.label}>Preview poster frame</div>
      <div className={`${styles.preview} ${styles.posterScrubPreview}`}>
        <video
          ref={videoRef}
          src={src}
          playsInline
          muted
          preload="metadata"
          data-testid="poster-scrubber-video"
          onLoadedMetadata={onLoadedMetadata}
          onError={onError}
          onSeeked={() => {
            const v = videoRef.current;
            if (v && Number.isFinite(v.currentTime)) setScrub(v.currentTime);
          }}
        />
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
            disabled={!(duration > 0)}
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
                disabled={!(duration > 0)}
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
