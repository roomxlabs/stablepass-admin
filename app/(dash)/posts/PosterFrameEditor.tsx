"use client";

/**
 * ENG-825 — posts-library poster frame editor.
 *
 * Opens the reused compose `PosterScrubber` over the post's signed HLS
 * (`HlsVideo` inside the scrubber). "Use this frame" POSTs `{ time }` to the
 * BFF poster route → BE `rebake-poster`. States: baking / success / error.
 * On BE failure the old poster stays intact (no local optimistic write of
 * poster_url).
 *
 * `needs-design-check`: no library mockup — scrubber styling comes from compose.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import PosterScrubber from "../compose/PosterScrubber";
import { rebakePoster } from "./api";

type Props = {
  postId: string;
  /** Signed Mux HLS URL (server-minted). Never a raw Mux credential. */
  playbackUrl: string;
  /** Current `post.poster_time_s`, or null. */
  posterTimeS: number | null;
  /** Called after a successful re-bake so the row thumb can swap immediately. */
  onPosterUpdated?: (posterDisplayUrl: string | null, posterTimeS: number) => void;
};

export default function PosterFrameEditor({
  postId,
  playbackUrl,
  posterTimeS,
  onPosterUpdated,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selectedTimeS, setSelectedTimeS] = useState<number | null>(posterTimeS);
  const [baking, setBaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, startTransition] = useTransition();

  async function onPick(timeS: number) {
    setError(null);
    setSuccess(false);
    setBaking(true);
    try {
      const result = await rebakePoster(postId, timeS);
      setSelectedTimeS(result.posterTimeS);
      setSuccess(true);
      onPosterUpdated?.(result.posterDisplayUrl, result.posterTimeS);
      // Re-run the server component so list data (poster_url / poster_time_s) matches.
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Poster re-bake failed.");
      // Intentionally do NOT touch the displayed poster — old one stays.
    } finally {
      setBaking(false);
    }
  }

  return (
    <div className="poster-frame-editor" data-testid="poster-frame-editor" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        data-testid="choose-preview-frame"
        disabled={baking || pending}
        onClick={() => {
          setOpen((v) => !v);
          setError(null);
          setSuccess(false);
        }}
      >
        {open ? "Close preview frame" : "Choose preview frame"}
      </button>

      {open ? (
        <div className="poster-frame-panel" data-testid="poster-frame-panel">
          <PosterScrubber
            key={playbackUrl}
            src={playbackUrl}
            selectedTimeS={selectedTimeS}
            onPick={onPick}
            disabled={baking || pending}
          />
          {baking ? (
            <div className="poster-frame-status" data-testid="poster-baking" role="status">
              Baking poster…
            </div>
          ) : null}
          {success && !baking ? (
            <div className="poster-frame-status ok" data-testid="poster-bake-ok" role="status">
              Poster updated.
            </div>
          ) : null}
          {error ? (
            <div className="poster-frame-status err" data-testid="poster-bake-err" role="alert">
              {error}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
