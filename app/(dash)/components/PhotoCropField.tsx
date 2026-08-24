"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./PhotoCropField.module.css";
import {
  ZOOM_MIN,
  centredPan,
  clampZoom,
  cropRect,
  extForMime,
  maxZoom,
  outputEdge,
  outputFormat,
  panAfterDrag,
  panForZoom,
  type Point,
  type Size,
} from "./photoCrop";
import { canvasSupported, cropToBlob, loadImage, type LoadedImage } from "./photoCropCanvas";

// ENG-749 — the crop step both HorseForm and TrainerForm mount after a file is
// picked. Mel's report: subjects sit wrongly in the circular avatars, because
// every photo was uploaded raw and every surface renders a centre crop of it.
//
// The crop is baked into the bytes BEFORE upload, so the stored object IS the
// cropped image and no renderer, column or member surface changes. That is also
// why this does not conflict with guardrail #5: the guardrail forbids mutating
// a STORED asset (the watermark must stay a display-time overlay). This runs
// before anything is stored — it produces the source asset rather than editing
// one — and it uploads to a fresh path exactly as the previous flow did. No
// existing object is ever read, rewritten or overwritten by this component.
//
// Deliberately dependency-free: the repo ships no image libraries, and a square
// pan/zoom crop is a `drawImage` call plus the arithmetic in photoCrop.ts. The
// nearest off-the-shelf option (react-easy-crop) is ~40 kB for the same result.

export type PickedPhoto = {
  /** The bytes to upload: the cropped output, or the original File as-is. */
  blob: Blob;
  /** Extension the upload path must use — it describes the BYTES, not the pick. */
  ext: string;
  cropped: boolean;
};

type Props = {
  file: File;
  /** Names the subject in the dialog copy, e.g. "trainer" or "horse". */
  subject: string;
  onCancel: () => void;
  onApply: (picked: PickedPhoto) => void;
};

/**
 * The extension the two forms already derive from the picked file. Preserved
 * exactly for the use-as-is path so that route stays what it was before this
 * ticket, down to the stored object's key.
 */
function originalExt(file: File): string {
  return file.name.split(".").pop() || "jpg";
}

export default function PhotoCropField({ file, subject, onCancel, onApply }: Props) {
  const imageRef = useRef<LoadedImage | null>(null);
  const [image, setImage] = useState<LoadedImage | null>(null);
  const [zoom, setZoom] = useState(ZOOM_MIN);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewportPx, setViewportPx] = useState(360);
  const dragRef = useRef<{ id: number; x: number; y: number } | null>(null);

  // `onApply` is read through a ref, NOT closed over as a dependency. Both
  // parents declare their handler inline, so it is a new function on every
  // parent render — and depending on it made the load effect below re-run
  // whenever the FORM re-rendered for any unrelated reason (the edit page's
  // signPhoto resolving, an admin typing a name). That re-ran loadImage and
  // reset `pan` to centre, silently throwing away the framing the admin had
  // just dragged. Measured: three decodes of one picked file.
  const onApplyRef = useRef(onApply);
  useEffect(() => {
    onApplyRef.current = onApply;
  });

  const applyAsIs = useCallback(() => {
    onApplyRef.current({ blob: file, ext: originalExt(file), cropped: false });
  }, [file]);

  useEffect(() => {
    let cancelled = false;

    // No canvas (jsdom, a locked-down browser) means no crop is POSSIBLE. Skip
    // straight through rather than showing a crop UI whose Apply button cannot
    // work — the photo still uploads, exactly as it did before this ticket.
    if (!canvasSupported()) {
      applyAsIs();
      return;
    }

    void loadImage(file).then((loaded) => {
      if (cancelled) {
        loaded?.release();
        return;
      }
      if (!loaded) {
        // Undecodable bytes. Let the upload proceed and let Storage or the
        // member surface be the thing that complains, which is what happened
        // before this component existed.
        applyAsIs();
        return;
      }
      imageRef.current = loaded;
      setImage(loaded);
      setZoom(ZOOM_MIN);
      setPan(centredPan({ width: loaded.width, height: loaded.height }, ZOOM_MIN));
    });

    return () => {
      cancelled = true;
    };
  }, [file, applyAsIs]);

  // Revoke on unmount only — the URL backs the <img> for the dialog's lifetime.
  useEffect(
    () => () => {
      imageRef.current?.release();
      imageRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const measure = () => {
      const width = viewportRef.current?.getBoundingClientRect().width;
      if (width && width > 0) setViewportPx(width);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [image]);

  // Dismissal is refused mid-encode. Both buttons are already disabled while
  // busy, but the backdrop and Escape were not: dismissing during the encode
  // unmounted the dialog while `apply()` was still awaiting, and the pending
  // onApply then uploaded the photo anyway — a cancel that silently saved.
  const dismiss = useCallback(() => {
    if (!busy) onCancel();
  }, [busy, onCancel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss]);

  const source: Size = image
    ? { width: image.width, height: image.height }
    : { width: 1, height: 1 };
  const rect = cropRect(source, zoom, pan);
  const displayScale = viewportPx / rect.size;

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!image) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.id !== e.pointerId || !image) return;
    const delta = { x: e.clientX - drag.x, y: e.clientY - drag.y };
    dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    setPan((p) => panAfterDrag(source, zoom, p, delta, viewportPx));
  }

  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.id === e.pointerId) dragRef.current = null;
  }

  function onZoom(next: number) {
    const clamped = clampZoom(source, next);
    setPan((p) => panForZoom(source, zoom, p, clamped));
    setZoom(clamped);
  }

  async function apply() {
    const loaded = imageRef.current;
    if (!loaded) {
      applyAsIs();
      return;
    }
    setBusy(true);
    const format = outputFormat(file.type);
    const blob = await cropToBlob(loaded.el, cropRect(source, zoom, pan), format);
    if (!blob) {
      // Encoding failed at the last step. Losing the admin's framing is far
      // better than losing the photo, so fall back rather than dead-end.
      applyAsIs();
      return;
    }
    // Keyed off the mime the encoder ACTUALLY returned, not the one we asked
    // for: toBlob is allowed to fall back to PNG when it cannot honour the
    // request, and a .jpg key over PNG bytes is the divergence photoCrop.ts
    // exists to prevent.
    onApply({ blob, ext: extForMime(blob.type), cropped: true });
  }

  return (
    <div className={styles.root} role="dialog" aria-modal="true" aria-label={`Position the ${subject} photo`} data-testid="photo-crop-dialog">
      <div className={styles.backdrop} onClick={dismiss} />
      <div className={styles.panel}>
        <h2 className={styles.title}>Position the photo</h2>
        <div className={styles.sub}>
          Drag the photo to move it and use the slider to zoom. The circle is what shows on the
          {` ${subject}'s`} profile; the whole square is saved.
        </div>

        {image ? (
          <>
            <div
              ref={viewportRef}
              className={styles.viewport}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              data-testid="photo-crop-viewport"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- local object URL, not a remote asset */}
              <img
                className={styles.image}
                src={image.url}
                alt=""
                draggable={false}
                style={{
                  width: source.width * displayScale,
                  height: source.height * displayScale,
                  left: -rect.x * displayScale,
                  top: -rect.y * displayScale,
                }}
              />
              <div className={styles.circleGuide} />
            </div>

            <div className={styles.zoomRow}>
              <span className={styles.zoomLabel}>Zoom</span>
              <input
                className={styles.zoom}
                type="range"
                min={ZOOM_MIN}
                max={maxZoom(source)}
                step={0.01}
                value={zoom}
                onChange={(e) => onZoom(Number(e.target.value))}
                aria-label="Zoom"
                data-testid="photo-crop-zoom"
              />
            </div>
            <div className={styles.meta} data-testid="photo-crop-meta">
              Saving {outputEdge(rect.size)}×{outputEdge(rect.size)} from a {source.width}×
              {source.height} photo
            </div>
          </>
        ) : (
          <div className={styles.loading}>Preparing photo…</div>
        )}

        <div className={styles.actions}>
          <button
            type="button"
            className={`btn btn-light ${styles.asIs}`}
            style={{ padding: "8px 16px", fontSize: "13px" }}
            onClick={applyAsIs}
            disabled={busy}
            data-testid="photo-crop-use-as-is"
          >
            Use as-is
          </button>
          <button
            type="button"
            className="btn btn-light"
            style={{ padding: "8px 16px", fontSize: "13px" }}
            onClick={dismiss}
            disabled={busy}
            data-testid="photo-crop-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            style={{ padding: "8px 18px", fontSize: "13px" }}
            onClick={apply}
            disabled={busy || !image}
            data-testid="photo-crop-apply"
          >
            {busy ? "Applying…" : "Apply crop"}
          </button>
        </div>
      </div>
    </div>
  );
}
